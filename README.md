# Email Checker

A Windows desktop app that organizes **Microsoft 365** and **Gmail** inboxes with local AI.

It classifies unread mail into folders you define, keeps credentials encrypted on disk, and can notify you from the tray when new messages are processed.

## Features

- Connect multiple Outlook and Gmail accounts
- Classify with **Ollama** (local) or **OpenRouter**
- Dry-run first: report decisions without moving mail
- System tray, floating window, and Windows notifications
- Optional Slack incoming-webhook run summaries
- Optional Azure relay for push mail, with backup polling

## Safety defaults

- The first run is a **dry run**
- Only unread Inbox messages are processed unless you change that
- The model can choose only from your folder allow-list
- Low-confidence results go to `Review`
- Mail stays unread unless you enable **Mark as read**
- Classifiers receive sender, subject, received time, and a short preview — not full bodies
- Secrets (tokens, API keys, Slack webhook) are stored with Windows DPAPI

`Mail.ReadWrite` is required for Outlook so messages can be moved. Email Checker does not call delete or send endpoints. Do not add `Mail.Send`.

## Requirements

- Windows 10 or later
- [Node.js 22+](https://nodejs.org/)
- [Ollama](https://ollama.com/) if you classify locally

## Run locally

```powershell
npm install
npm run dev
```

Then in the app:

1. Add a Microsoft or Gmail account on **Accounts**
2. Choose a model and folders on **AI & Rules**
3. Keep **Dry run** on and use **Run once**
4. Review the JSON/CSV report
5. Turn off dry-run only after the decisions look correct

```powershell
npm test
npm run typecheck
```

To build a Windows installer:

```powershell
npm run dist
```

## Push mail (optional)

The desktop app does not open a public webhook. Production push delivery uses an Azure Functions relay. See:

- [Azure relay contract](docs/azure-relay-contract.md)
- [Azure and Google push setup](docs/setup-azure-google-push.md)

Without a relay, automatic monitoring still works via scheduled backup polling.

## License

MIT
