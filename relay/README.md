# Email Checker push relay

Azure Functions v4 relay for Microsoft Graph and Gmail Pub/Sub notifications.
It stores only registration metadata and verification hashes in Azure Table
Storage, then publishes account-scoped change signals through Azure Web PubSub.

## Local run

Install Node.js 22, Azure Functions Core Tools v4, and Azurite. From the
repository root:

```powershell
npm install
Copy-Item relay/local.settings.example.json relay/local.settings.json
```

Replace every placeholder in `relay/local.settings.json`. Use an Azurite
connection string for `AzureWebJobsStorage` when running storage locally.
Start `azurite` in a separate PowerShell window, then:

```powershell
Set-Location relay
npm test
npm run typecheck
npm start
```

The health check is `http://localhost:7071/api/health`. Provider callbacks need
a public HTTPS URL; use a controlled development tunnel and configure its exact
Gmail URL as `GOOGLE_PUBSUB_AUDIENCE`. Never commit `local.settings.json`.

See `../docs/setup-azure-google-push.md` for production provisioning and
`../docs/azure-relay-contract.md` for the HTTP/event contract.
