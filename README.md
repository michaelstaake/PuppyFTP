# PuppyFTP

Cute, fast, AI-powered open-source FTP + SSH/SFTP desktop client.

## Features

- Dual-pane file manager for local and remote browsing
- SSH terminal with xterm.js
- Remote tree cache and search for faster navigation
- Ask AI assistant for remote servers (OpenAI-compatible APIs)
- Portable JSON configuration for easy backup and sync
- System tray and global hotkey support

## Install / download

Download a prebuilt installer from the [Releases](https://github.com/michaelstaake/PuppyFTP/releases) page:

| Platform | Download |
| --- | --- |
| Windows | `.exe` installer (NSIS) or portable build |
| macOS | `.dmg` |
| Linux | `.AppImage` or `.deb` |

Installers are built automatically when a version tag is pushed (for example `v1.0.1`).

## Quick start (from source)

Requirements: **Node.js 20+**

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npm run package
# or Windows:
npm run build:win
```

## Configuration

App data lives in the Electron **userData** directory (servers, settings, transfer history, etc.).

- Credentials are stored in **plaintext JSON by default** so you can back up and sync configuration across machines.
- Optional **Protect server data** in Settings encrypts `servers.json` with the OS keychain (Electron `safeStorage`). Encrypted data is not portable across machines.

See [SECURITY.md](SECURITY.md) for the threat model.

## AI setup

In **Settings → AI**, configure:

- Base URL (OpenAI-compatible endpoint)
- Model name
- API key

Enable Ask AI and optional command-running permissions as needed.

## License

[GPL-3.0](LICENSE)