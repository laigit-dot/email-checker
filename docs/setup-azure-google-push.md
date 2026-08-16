# Set up Azure and Google push delivery

This guide provisions the production relay used by Email Checker. It assumes a
new Azure subscription, a new Google Cloud project, and Windows PowerShell.
Commands keep secrets in the current PowerShell process; do not paste their
resolved values into source files, screenshots, tickets, or shell scripts that
will be committed.

The relay receives metadata-only notifications. It does not receive or publish
message bodies, subjects, previews, OAuth tokens, or attachment content.

## 1. Install prerequisites and sign in

Install:

- [Node.js 22 LTS](https://nodejs.org/)
- [Git for Windows](https://git-scm.com/download/win)
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli-windows)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- [Google Cloud CLI](https://cloud.google.com/sdk/docs/install-sdk)
- Optional for local storage: [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite)

Open a new PowerShell window and verify the tools:

```powershell
node --version
npm --version
az version
func --version
gcloud version
```

Sign in and select the intended Azure subscription:

```powershell
az login
az account list --output table
az account set --subscription "<azure-subscription-name-or-id>"
az account show --output table
```

Sign in to Google:

```powershell
gcloud auth login
gcloud auth list
```

## 2. Set naming variables

Run this once in the same PowerShell session. Azure Storage names must be
globally unique, lowercase, and no more than 24 characters. Function App and
Web PubSub names must also be globally unique.

```powershell
$Suffix = ([Guid]::NewGuid().ToString("N")).Substring(0, 8)

$AzureLocation = "eastus2"
$ResourceGroup = "rg-email-checker-$Suffix"
$StorageAccount = "emailrelay$Suffix"
$FunctionApp = "email-checker-relay-$Suffix"
$WebPubSub = "email-checker-wps-$Suffix"
$WebPubSubHub = "email"
$RegistrationTable = "RelayRegistrations"

$GoogleProjectId = "email-checker-$Suffix"
$GoogleProjectName = "Email Checker"
$TopicId = "gmail-push"
$SubscriptionId = "gmail-push-to-azure"
$PushServiceAccountName = "gmail-push-relay"

$Repository = "C:\Users\Administrator\Documents\CodeShop\email-checker"
```

Choose a Flex Consumption region supported by your subscription if `eastus2`
is unavailable:

```powershell
az functionapp list-flexconsumption-locations --output table
```

## 3. Create Azure resources

Register the resource providers and wait for registration:

```powershell
az provider register --namespace Microsoft.Web
az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.SignalRService

$Providers = @(
  "Microsoft.Web",
  "Microsoft.Storage",
  "Microsoft.SignalRService"
)
foreach ($Provider in $Providers) {
  while (
    (az provider show --namespace $Provider `
      --query registrationState --output tsv) -ne "Registered"
  ) {
    Start-Sleep -Seconds 5
  }
}
```

Create the resource group and a StorageV2 account:

```powershell
az group create `
  --name $ResourceGroup `
  --location $AzureLocation

az storage account create `
  --name $StorageAccount `
  --resource-group $ResourceGroup `
  --location $AzureLocation `
  --sku Standard_LRS `
  --kind StorageV2 `
  --https-only true `
  --min-tls-version TLS1_2 `
  --allow-blob-public-access false
```

Create the Node.js 22 Flex Consumption Function App:

```powershell
az functionapp create `
  --resource-group $ResourceGroup `
  --name $FunctionApp `
  --storage-account $StorageAccount `
  --flexconsumption-location $AzureLocation `
  --runtime node `
  --runtime-version 22 `
  --functions-version 4 `
  --https-only true
```

Create Azure Web PubSub. `Free_F1` is suitable for initial testing; use a paid
SKU before relying on production quotas and availability.

```powershell
az webpubsub create `
  --name $WebPubSub `
  --resource-group $ResourceGroup `
  --location $AzureLocation `
  --sku Free_F1 `
  --unit-count 1
```

Generate the single v1 desktop relay key in memory and retrieve Azure
connection strings:

```powershell
$RelayApiKey = [Convert]::ToBase64String(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(48)
)

$StorageConnection = az storage account show-connection-string `
  --name $StorageAccount `
  --resource-group $ResourceGroup `
  --query connectionString `
  --output tsv

$WebPubSubConnection = az webpubsub key show `
  --name $WebPubSub `
  --resource-group $ResourceGroup `
  --query primaryConnectionString `
  --output tsv

$RelayBaseUrl = "https://$FunctionApp.azurewebsites.net"
$GmailPushEndpoint = "$RelayBaseUrl/api/gmail/pubsub"
```

Do not print `$RelayApiKey`, `$StorageConnection`, or
`$WebPubSubConnection`.

## 4. Create the Google Cloud project

Project IDs are globally unique. If project creation reports a collision,
change `$GoogleProjectId` and rerun the create command.

```powershell
gcloud projects create $GoogleProjectId --name=$GoogleProjectName
gcloud config set project $GoogleProjectId
gcloud projects describe $GoogleProjectId
```

List billing accounts, choose one, and link it. This requires Billing Account
User permission on that billing account.

```powershell
gcloud billing accounts list
$GoogleBillingAccount = "<billing-account-id>"
gcloud billing projects link $GoogleProjectId `
  --billing-account=$GoogleBillingAccount
```

Enable the required APIs:

```powershell
gcloud services enable `
  gmail.googleapis.com `
  pubsub.googleapis.com `
  iam.googleapis.com `
  iamcredentials.googleapis.com
```

Get the numeric project number and create the push identity:

```powershell
$GoogleProjectNumber = gcloud projects describe $GoogleProjectId `
  --format="value(projectNumber)"

gcloud iam service-accounts create $PushServiceAccountName `
  --display-name="Email Checker authenticated Pub/Sub push"

$PushServiceAccount = "$PushServiceAccountName@$GoogleProjectId.iam.gserviceaccount.com"
$PubSubServiceAgent = "service-$GoogleProjectNumber@gcp-sa-pubsub.iam.gserviceaccount.com"
```

Allow the Pub/Sub service agent to mint OIDC tokens for authenticated push:

```powershell
gcloud projects add-iam-policy-binding $GoogleProjectId `
  --member="serviceAccount:$PubSubServiceAgent" `
  --role="roles/iam.serviceAccountTokenCreator"
```

If subscription creation later reports `iam.serviceAccounts.actAs`, grant the
signed-in administrator Service Account User on the push identity:

```powershell
$GoogleAdminEmail = gcloud config get-value account
gcloud iam service-accounts add-iam-policy-binding $PushServiceAccount `
  --member="user:$GoogleAdminEmail" `
  --role="roles/iam.serviceAccountUser"
```

## 5. Configure and publish the relay

Set Function App settings. The Gmail OIDC audience must exactly match
`$GmailPushEndpoint`, including scheme, host, path, and casing.

```powershell
az functionapp config appsettings set `
  --name $FunctionApp `
  --resource-group $ResourceGroup `
  --settings `
    "AzureWebJobsStorage=$StorageConnection" `
    "FUNCTIONS_WORKER_RUNTIME=node" `
    "RELAY_API_KEY=$RelayApiKey" `
    "RELAY_REGISTRATION_TABLE=$RegistrationTable" `
    "WEB_PUBSUB_CONNECTION_STRING=$WebPubSubConnection" `
    "WEB_PUBSUB_HUB=$WebPubSubHub" `
    "WEB_PUBSUB_TOKEN_TTL_MINUTES=60" `
    "GOOGLE_PUBSUB_AUDIENCE=$GmailPushEndpoint" `
    "GOOGLE_PUBSUB_SERVICE_ACCOUNT=$PushServiceAccount"
```

Install, verify, build, and publish from the relay package:

```powershell
Set-Location $Repository
npm install
npm run relay:verify

Set-Location "$Repository\relay"
func azure functionapp publish $FunctionApp
Set-Location $Repository
```

Confirm the public health endpoint:

```powershell
$Health = Invoke-RestMethod "$RelayBaseUrl/api/health"
$Health
```

Expected fields are `ok: true`, `version: 1`, and a current UTC `time`.

If the endpoint has not warmed yet, wait a few seconds and retry. Do not add a
Function key to provider URLs: these functions use anonymous Azure trigger
authorization and enforce their own relay-key or Google OIDC authentication.

## 6. Create the Gmail topic and authenticated push subscription

Create the topic:

```powershell
gcloud pubsub topics create $TopicId
```

Gmail publishes as a Google-managed service account. Grant only Publisher on
this topic:

```powershell
gcloud pubsub topics add-iam-policy-binding $TopicId `
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" `
  --role="roles/pubsub.publisher"
```

Create an authenticated push subscription. The endpoint and token audience are
intentionally identical:

```powershell
gcloud pubsub subscriptions create $SubscriptionId `
  --topic=$TopicId `
  --push-endpoint=$GmailPushEndpoint `
  --push-auth-service-account=$PushServiceAccount `
  --push-auth-token-audience=$GmailPushEndpoint `
  --ack-deadline=30
```

Inspect the non-secret configuration:

```powershell
gcloud pubsub subscriptions describe $SubscriptionId
gcloud pubsub topics get-iam-policy $TopicId
```

The full Gmail watch topic name used by the desktop is:

```powershell
$GooglePubSubTopic = "projects/$GoogleProjectId/topics/$TopicId"
$GooglePubSubTopic
```

## 7. Configure Gmail OAuth

These are **Google Cloud Console-only steps** because OAuth consent and desktop
client creation are managed in the Google Auth Platform UI:

1. Open the Google Cloud Console and select `$GoogleProjectId`.
2. Go to **Google Auth Platform > Branding**. Enter the application name,
   support email, and developer contact.
3. Under **Audience**, choose **External** for consumer Gmail accounts or
   **Internal** for a Google Workspace-only deployment.
4. If the app is in Testing, add each Gmail account as a test user. Testing
   status and sensitive Gmail scopes can impose token lifetime or user limits;
   complete Google's production/verification process before broader use.
5. Under **Data Access**, add
   `https://www.googleapis.com/auth/gmail.modify`. The desktop needs this scope
   to read, label/move, and mark messages as read.
6. Under **Clients**, create an OAuth client of type **Desktop app**.
7. Copy the client ID and client secret directly into Email Checker when
   configuring the desktop. Do not put them in this repository.

When monitoring starts, the desktop calls Gmail `users.watch` with
`$GooglePubSubTopic`. Gmail sends `{emailAddress, historyId}` through Pub/Sub;
the relay maps the address to the registered account and forwards only the
history cursor. Gmail watches expire and must be renewed. The desktop renews
the provider watch and relay registration before expiry.

## 8. Configure Microsoft Entra ID for device code

Create a single-tenant public client:

```powershell
$EntraDisplayName = "Email Checker Desktop"
$EntraApp = az ad app create `
  --display-name $EntraDisplayName `
  --sign-in-audience AzureADMyOrg | ConvertFrom-Json

$AzureClientId = $EntraApp.appId
$AzureTenantId = az account show --query tenantId --output tsv

az ad app update `
  --id $AzureClientId `
  --is-fallback-public-client true
```

Resolve Microsoft Graph delegated permission IDs dynamically and add the exact
permissions used by the desktop:

```powershell
$MicrosoftGraphAppId = "00000003-0000-0000-c000-000000000000"
$MailReadWriteScopeId = az ad sp show `
  --id $MicrosoftGraphAppId `
  --query "oauth2PermissionScopes[?value=='Mail.ReadWrite'].id | [0]" `
  --output tsv
$OfflineAccessScopeId = az ad sp show `
  --id $MicrosoftGraphAppId `
  --query "oauth2PermissionScopes[?value=='offline_access'].id | [0]" `
  --output tsv

az ad app permission add `
  --id $AzureClientId `
  --api $MicrosoftGraphAppId `
  --api-permissions `
    "$MailReadWriteScopeId=Scope" `
    "$OfflineAccessScopeId=Scope"
```

An Entra administrator can pre-consent for the tenant:

```powershell
az ad app permission admin-consent --id $AzureClientId
```

If tenant policy allows user consent, omit the admin-consent command and
approve during device-code login. If `az ad app update` is unavailable in your
installed CLI, use the **Microsoft Entra admin center**:

1. Open **App registrations > Email Checker Desktop > Authentication**.
2. Under **Advanced settings**, set **Allow public client flows** to **Yes**.
3. Under **API permissions**, confirm delegated `Mail.ReadWrite` and
   `offline_access`.

Microsoft Graph subscription creation uses the relay's
`/api/outlook/notifications` endpoint, a random `clientState`, and the
`/api/outlook/lifecycle` lifecycle endpoint. The relay stores only the
SHA-256 hash of `clientState`.

## 9. Configure the desktop

Open Email Checker settings and enter:

- Relay base URL: `$RelayBaseUrl`
- Relay API key: the in-memory `$RelayApiKey` value
- Azure client ID: `$AzureClientId`
- Azure tenant ID: `$AzureTenantId`
- Google client ID and secret: the Console-created Desktop OAuth credentials
- Google Pub/Sub topic: `$GooglePubSubTopic`
- A backup poll interval appropriate for your mailbox

Save the relay API key and Google client secret through the desktop secret
controls. The app stores them in its encrypted main-process secret store. Do
not put these values in renderer code, JSON configuration committed to Git, or
environment files in the repository.

Connect each Outlook and Gmail account, then start monitoring. The desktop:

1. Creates or renews the provider watch.
2. Registers provider/account metadata with the relay.
3. Negotiates a short-lived signed Web PubSub client URL.
4. Connects as the opaque installation ID derived from the relay key.

## 10. End-to-end test checklist

1. `GET $RelayBaseUrl/api/health` returns HTTP 200.
2. Start desktop monitoring; it reports push connected and backup polling
   enabled.
3. Confirm an Outlook registration exists in the Azure Table without any
   plaintext `clientState`.
4. Send a message to the connected Outlook inbox. Confirm Email Checker syncs
   that account.
5. Trigger an Outlook subscription lifecycle event by renewing or recreating
   the subscription; confirm the relay emits a lifecycle signal and the
   desktop renews.
6. Send a message to the connected Gmail inbox. Confirm Pub/Sub reports
   successful push delivery and Email Checker syncs that account from the
   received history cursor.
7. Stop the desktop. Provider push may still be accepted by the relay, but no
   message content is retained; backup polling catches any missed change after
   restart.
8. Use a wrong relay key against `/api/desktop/negotiate`; expect HTTP 401.
9. Use a wrong Graph `clientState`; expect HTTP 403 and no Web PubSub event.
10. Publish a valid Gmail notification for an unregistered address; expect a
    2xx acknowledgement and no retry storm.

Do not include signed WebSocket URLs, bearer tokens, Pub/Sub bodies, email
payloads, connection strings, or relay keys in test logs.

## 11. Renewal and backup polling

Push delivery is an acceleration signal, not the source of truth:

- Microsoft Graph subscriptions expire and are renewed before their
  `expirationDateTime`.
- Gmail `users.watch` expires (normally within days) and must be renewed.
- Web PubSub client URLs are short-lived and renegotiated when reconnecting.
- Relay registrations carry the provider expiry and are replaced idempotently
  on renewal.
- The hourly timer removes expired registration and lookup rows.
- Desktop backup polling remains enabled even when push is connected. It
  catches provider outages, expired watches, sleeping devices, and at-least-once
  delivery gaps.

The desktop's provider history/delta cursors make repeated notifications
idempotent. Never use the relay event itself as evidence that every message was
processed.

## 12. Rotation and cleanup

### Relay API key

Version 1 has one configured key, and its SHA-256 digest is also the Web PubSub
installation/user ID. Rotate it as a coordinated change:

1. Generate a new random key in PowerShell.
2. Update `RELAY_API_KEY` on the Function App.
3. Update the encrypted desktop relay key.
4. Restart monitoring so every provider account re-registers and negotiates a
   new Web PubSub URL.
5. Let old registrations expire; the hourly cleanup deletes them.

There is no overlap window in v1. Rotating only one side temporarily disables
desktop registration and negotiation.

### Web PubSub keys

Regenerate the secondary key, update
`WEB_PUBSUB_CONNECTION_STRING`, validate, then regenerate the primary key and
update again if desired:

```powershell
az webpubsub key regenerate `
  --name $WebPubSub `
  --resource-group $ResourceGroup `
  --key-type Secondary
```

Retrieve the new connection string into a PowerShell variable and update the
Function App setting without printing it.

### Google push identity

Create a replacement service account, grant the Pub/Sub service agent token
creator permission, update the subscription's push authentication, then update
`GOOGLE_PUBSUB_SERVICE_ACCOUNT`. Keep
`GOOGLE_PUBSUB_AUDIENCE` exactly aligned with the configured subscription
audience.

### Remove all resources

After exporting anything you must retain:

```powershell
gcloud pubsub subscriptions delete $SubscriptionId
gcloud pubsub topics delete $TopicId
gcloud projects delete $GoogleProjectId

az group delete --name $ResourceGroup --yes --no-wait
```

Deleting the resource group removes the Function App, its storage, Application
Insights, and Web PubSub.

## 13. Troubleshooting

### Function App returns 503

- Run `az functionapp config appsettings list --name $FunctionApp
  --resource-group $ResourceGroup` and check that every required setting name
  exists. Avoid sharing the output because values include secrets.
- Confirm the Storage and Web PubSub connection strings belong to the created
  resources.
- Confirm the registration table name uses only letters and digits and starts
  with a letter.
- Republish after `npm run relay:verify`.

### Gmail push returns 401

- Confirm the subscription uses authenticated push.
- Confirm `--push-auth-token-audience` exactly equals
  `GOOGLE_PUBSUB_AUDIENCE`.
- Confirm the subscription's push service account exactly equals
  `GOOGLE_PUBSUB_SERVICE_ACCOUNT`.
- Confirm the Pub/Sub service agent has Service Account Token Creator.
- Do not use an OAuth access token in place of the Pub/Sub OIDC ID token.

### Gmail watch or publish fails

- Confirm the Gmail API and Pub/Sub API are enabled in the same project named
  in the full topic.
- Confirm `gmail-api-push@system.gserviceaccount.com` has Pub/Sub Publisher on
  the topic.
- Confirm the signed-in Gmail user is a test user while OAuth is in Testing.
- Confirm the desktop OAuth grant includes `gmail.modify`.

### Graph validation fails

- Both Graph endpoints accept `validationToken` and return its URL-decoded text
  as `text/plain` HTTP 200.
- The endpoint must be publicly reachable over HTTPS during subscription
  creation.
- Do not place desktop bearer authentication in front of the Graph endpoints.

### Graph notifications return 403

- The incoming `subscriptionId` must match the registered `resourceId`.
- The incoming `clientState` must exactly match the secret generated for that
  subscription. Renewing a subscription must also update relay registration.
- A 403 notification is intentionally not forwarded.

### Push is connected but mail is delayed

- Verify the desktop account/provider pair matches the relay event.
- Check provider history/delta cursor errors and watch expiry.
- Keep backup polling enabled; it is the recovery path for missed or delayed
  push signals.
- Check Azure and Google metrics, but do not enable request-body or token
  logging.
