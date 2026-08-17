# Matalia SL Frontend Launcher

## How to launch

Double-click `launch_frontend.bat` from the `frontend` folder.

The launcher will:

1. Check that Node.js and npm are available.
2. Install dependencies when `node_modules` is missing.
3. Start the Vite development server.
4. Start on port `3489`.
5. Open the running UI automatically in your browser.

You can also run the PowerShell launcher directly:

```powershell
.\launch_frontend.ps1
```

## Requirements

- Windows with PowerShell available
- Node.js 18 or newer
- npm available on `PATH`
- A browser such as Chrome, Edge, or Firefox

## Folder structure

```text
frontend/
├── launch_frontend.bat       # Double-click launcher
├── launch_frontend.ps1       # PowerShell launcher logic
├── package.json              # Frontend scripts and dependencies
├── src/                      # React + TypeScript application
└── README_FRONTEND.md        # This guide
```

## Troubleshooting

### Node.js is not installed

Install Node.js from [nodejs.org](https://nodejs.org/), restart the terminal, and run the launcher again.

### npm install fails

Read the error shown in the launcher window. Common causes are a blocked network connection, a corporate proxy, or an invalid npm registry configuration. Run this manually from `frontend` to see the full output:

```powershell
npm install
```

### The browser does not open

Open the URL printed in the launcher window manually. The normal address is:

```text
http://localhost:3489
```

If that port is occupied, the launcher reports the conflict and does not start a different frontend port.

### Stop the server

Return to the launcher window and press `CTRL+C`.
