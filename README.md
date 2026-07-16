# PuppyFTP

Opensource, free FTP/SFTP + SSH desktop client with optional AI enhancements.

## Why PuppyFTP

- Easily manage multiple SSH, FTP, SFTP servers in one modern interface.
- Portable JSON configuration for easy backup and sync across multiple PCs.
- AI assistance that works with local, self-hosted, and API providers that can help you manage your servers and find files.
- Prebuilt Windows setup and portable images, with support for Linux and MacOS via DIY builds.

## Get PuppyFTP

Windows: Download prebuilt images from the [Releases](https://github.com/michaelstaake/PuppyFTP/releases) page:

| Artifact | Description |
| --- | --- |
| `PuppyFTP-Setup-*.exe` | NSIS installer |
| `PuppyFTP-Portable-*.exe` | Portable build |

Windows setup and portable builds are published automatically when a version tag is pushed.

MacOS and Linux are not built by CI, but you can build them from source:

### Development

Requirements: **Node.js 20+**

```bash
npm install
npm run dev
```

### Production

```bash
npm run build
npm run build:win    # Windows setup + portable
npm run build:mac    # macOS .dmg + .zip
npm run build:linux  # Linux AppImage + .deb
```

Note: As we have not implemented code signing, you may receive warnings from your OS about running unknown programs, or in some cases, false positives from certain AV software. This is expected behavior and is safe to ignore.

## AI Features

To use AI features, PuppyFTP must be connected to an OpenAI-compatible endpoint, whether running on your PC, on a self-hosted AI server, or cloud API. For your convenience, we have some presets that you can access by typing / in the Base URL input field.

- LM Studio
- LmPanel
- OpenRouter
- SpaceXAI (xAI Grok)
- Anthropic (Claude)
- OpenAI (GPT)
- Google (Gemini)

Once your API key (if applicable) and base URL are set, PuppyFTP will automatically attempt to fetch the available models. Type / in the Model input field to see a list of available models. In some cases, fetching the available models will not work, in which case you can enter the model name manually.

## File Location / Syncing Between PCs

App data lives in the Electron **userData** directory (servers, settings, transfer history, etc.).

- Credentials are stored in **plaintext JSON by default**. This is not particularly secure but makes it very easy to back up and sync configuration across machines.
- Optional **Protect server data** in Settings encrypts `servers.json` with the OS keychain (Electron `safeStorage`) if file portability is not of interest to you.

## Need Help?

Please use the [GitHub Issues](https://github.com/michaelstaake/PuppyFTP/issues) to get support, report bugs, and suggest improvements.

## License

[GPL-3.0](LICENSE)