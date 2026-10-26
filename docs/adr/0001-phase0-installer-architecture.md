# ADR 0001 — Phase 0 installer architecture

Status: proposed (Phase 0 spike, awaiting owner approval)

## Decisions

1. **One installer, two modes** (Inno Setup). The first page asks "server computer or user computer"
   (SPEC 6). Server mode installs desktop app + server + PostgreSQL; user mode installs the desktop app only.
2. **Server provisioning is a Node script** (`apps/server/src/setup`) run by the bundled `node.exe` at the end
   of setup. It runs fixed steps (folders, secrets, `initdb`, PostgreSQL service, database, certificate,
   WinSW service, firewall rule, health check). If any step fails, all finished steps are undone in reverse
   order, the installer removes its files, and a clear message with an error code is shown (SPEC 6.1).
3. **PostgreSQL 16** (official EDB Windows binaries) runs as Windows service `AlyassirPostgres`
   under NETWORK SERVICE, on `127.0.0.1:5433` only, with `fsync`, `synchronous_commit` and
   `full_page_writes` on (SPEC 4.17, 6.1). Its data folder is closed to ordinary Windows users.
4. **The API** runs as Windows service `AlyassirServer` through WinSW v2, starts automatically with Windows,
   depends on the database service, and restarts by itself if it crashes. Settings (port, database URL,
   certificate) are environment variables written in the WinSW file, which only administrators can read (SPEC 4.13).
5. **HTTPS**: a self-signed certificate (RSA 2048, 20 years) is created with Windows' own
   `New-SelfSignedCertificate`, exported to a password-protected PFX, and removed from the Windows store.
   Its SHA-256 fingerprint is shown at the end of setup (SPEC 4.14).
6. **Firewall**: one inbound TCP rule for the chosen port, **private networks only** (SPEC 6.1).
7. **Desktop trust model**: the app never trusts a certificate authority. On first connection it shows the
   fingerprint; after the user confirms it, every connection must present exactly that certificate
   (pinning, in Rust `server-link`). A different certificate is refused with a clear warning.
8. **Uninstall** removes the services and the firewall rule but **never deletes the data folder**.
   Installing on a computer whose data folder already holds a database is refused (no overwrite).
9. **Tests run on GitHub Windows machines**, never on the owner's computer (owner's decision).

## Notes and limits of the spike

- No login, users or business features yet (Phase 1+). The only API route is `GET /api/health`.
- Tailwind, shadcn/ui and the Cairo font are not used yet; they arrive with the real UI in Phase 1.
- The installer is not code-signed, so Windows SmartScreen shows a warning.
- GitHub test machines run Windows Server 2022, not Windows 11; the final check on Windows 11 is
  planned by the owner at the end of the project.
