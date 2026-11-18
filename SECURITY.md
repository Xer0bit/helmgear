# Security policy

Helmgear is experimental and has not had a security audit. See [SAFETY.md](SAFETY.md) before running it.

## Reporting a vulnerability

Report privately through [GitHub security advisories](https://github.com/Xer0bit/helmgear/security/advisories/new). Do not open a public issue.

Include the affected version or commit, the steps to reproduce, and the impact you observed. Only the latest release is supported.

## What counts

- An agent running a `send` action without approval
- An approval running anything other than the stored payload
- One tenant reaching another tenant's data, connectors or memory
- An agent gaining a shell, file access or tools its template does not list
- Secrets or payloads reaching the audit log, or leaking to the agent process
- The Firecrawl connector reaching local or private addresses
- Untrusted text becoming memory without approval

Wrong or low-quality model output is not a vulnerability unless it gets past one of these controls.
