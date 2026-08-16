# Inbox Pilot

A local desktop organizer for multiple Outlook / Microsoft 365 accounts. It uses
Microsoft Graph for mailbox access and Ollama for classification.

## Safety defaults

- The first run is a **dry run**: it classifies and reports without moving mail.
- Only unread Inbox messages are processed.
- The model can choose only from your configured folder allow-list.
- Low-confidence or invalid results go to `Review`.
- Organized mail stays unread unless you explicitly enable **Mark as read**.
- Ollama receives only sender, subject, received time, and `bodyPreview`.
- Reports contain metadata and the AI decision. AI summaries/reasons can repeat
  sensitive text from the message preview, so protect and periodically remove
  old report files.
- Microsoft refresh tokens are stored locally using Windows DPAPI encryption.
- Ollama API keys and Slack webhook URLs are also stored with Windows DPAPI.

## Microsoft setup

Create an Entra app registration and configure:

1. **Authentication → Allow public client flows: Yes**
2. **API permissions → Microsoft Graph → Delegated permissions**
3. Add `Mail.ReadWrite`

`Mail.ReadWrite` permits reading, creating, moving, updating, and deleting mail.
Inbox Pilot intentionally never calls a delete endpoint. The permission does
**not** permit sending mail; do not add `Mail.Send`.

Copy the Application (client) ID into the GUI's **Accounts** page. Existing
accounts originally authorized with `Mail.Read` should be connected again so
Microsoft can request consent for `Mail.ReadWrite`.

## Run the GUI on Windows

```bat
.venv\Scripts\activate.bat
pip install -r requirements.txt
python organizer_gui.py
```

Then:

1. Save the Microsoft client ID.
2. Add each Outlook account and select the inboxes to process.
3. On **AI & Rules**, enter the Ollama URL (default:
   `http://localhost:11434`), load models, choose one, and edit the prompt.
4. Keep **Dry run** on and run the organizer.
5. Review the CSV/JSON report.
6. Disable dry-run only after the decisions look correct.

Ollama is accessed through its HTTP API using the official Python client.
Local Ollama does not require a username, password, or API key. If a secured
remote Ollama-compatible endpoint expects a Bearer token, enter it in the
optional API key field.

To deliver run summaries to Slack, create a Slack Incoming Webhook, paste its
URL into **AI & Rules → Slack report delivery**, send a test, and enable the
report switch. The webhook URL determines the destination channel.

The main window uses a dark custom title bar. Its status icon hides the main
window and opens a small always-on-top status bubble with moved, preview, and
failed badges. Double-click the bubble or use its restore button to reopen the
main window.

## Organization behavior

Inbox Pilot creates a parent folder (default `AI Organized`) and one child
folder per configured destination. A successful live run moves each message
into the selected child folder. If **Mark as read** is enabled, that update is
performed only after the move succeeds.

The **Automatic** control runs the organizer on the configured interval. For
true Microsoft Graph push notifications, the existing CLI webhook mode remains:

```bat
python email_watcher.py watch
```

That webhook mode requires a public HTTPS URL. The GUI interval mode does not.
