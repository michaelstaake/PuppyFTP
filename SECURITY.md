# Security

## Threat model

PuppyFTP is a desktop file and remote-access client. Users intentionally grant it access to local paths and remote servers.

### Local filesystem

- `fs:*` IPC handlers can read and write local paths the user requests through the UI. Treat this as inherent file-manager capability, not a sandbox boundary.

### Opening external links

- `shell:open-external` is restricted to `http:` and `https:` URLs only.

### Server credentials and configuration

- By default, `servers.json` stores connection credentials in plaintext JSON under the app userData directory for easy backup and sync across machines.
- Optional **Protect server data** (`protectServerData`) encrypts `servers.json` with the OS keychain via Electron `safeStorage`. Encrypted data is not portable across machines.

### FTPS / TLS

- FTPS validates TLS certificates by default.
- `allowInvalidCertificate` is an explicit opt-in to allow self-signed or otherwise untrusted certificates.

### SSH / SFTP host keys

- SSH/SFTP uses trust-on-first-use (TOFU): the host key fingerprint is stored on first successful connect and compared on later connects, with a warning if it changes.

### Reporting issues

Please report security concerns via the project issue tracker: https://github.com/michaelstaake/PuppyFTP/issues