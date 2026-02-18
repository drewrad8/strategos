# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| < 2.0   | No        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please email the maintainer directly. You should receive a response within 72 hours.

When reporting, please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Security Model

Strategos is designed for **local and trusted-network use**. It is not intended to be exposed to the public internet.

Key security measures:

- Server binds to `127.0.0.1` by default
- Optional API key authentication via `STRATEGOS_API_KEY`
- Rate limiting on all endpoints (300/min general, 30/min spawn)
- Per-socket event rate limiting
- Helmet security headers
- CORS origin validation
- Path traversal prevention (workers restricted to configured project directories)
- System path rejection (`/etc`, `/sys`, `/proc`, `/dev`, `/boot`, `/root`, `/var`, `/usr`, `/bin`, `/sbin`, `/lib`)
- Input validation on all user-supplied data (worker IDs, project names, task descriptions)
- No telemetry or external data collection

## Disclosure Policy

When a vulnerability is confirmed, we will:

1. Confirm the problem and determine affected versions
2. Prepare a fix
3. Release a patched version
4. Publish a security advisory if appropriate
