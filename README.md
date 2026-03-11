# @dmsdc-ai/aigentry-telepty

**Cross-machine PTY-based remote prompt injection daemon for AI CLIs.**

`telepty` (Tele-Prompt) is a lightweight background daemon that bridges the gap between the network and interactive AI command-line interfaces. It allows you to seamlessly share, attach to, and inject commands into terminal sessions across different machines.

## One-Click Installation & Update

To install or update `telepty` on any machine (macOS, Linux, or Windows), just run the command for your OS. (Node.js will be automatically installed if you don't have it).

### For macOS and Linux (Ubuntu, CentOS, etc.)
Open your terminal and run:
```bash
curl -fsSL https://raw.githubusercontent.com/dmsdc-ai/aigentry-telepty/main/install.sh | bash
```

### For Windows (PowerShell)
Open PowerShell as Administrator and run:
```powershell
iwr -useb https://raw.githubusercontent.com/dmsdc-ai/aigentry-telepty/main/install.ps1 | iex
```

*These single commands will install the package globally and automatically configure it to run as a background service specific to your OS (`systemd` for Linux, `launchd` for macOS, or a detached background process for Windows).*

## Seamless Usage

1. **Start a background session:**
   ```bash
   telepty spawn --id "my-session" bash
   ```

2. **Attach to a session (Local or Remote):**
   ```bash
   telepty attach
   ```
   *telepty will automatically discover active sessions on your local machine and across your Tailscale network!*

3. **Inject commands remotely:**
   ```bash
   telepty inject my-session "echo 'Hello from nowhere!'"
   ```

## Testing

Run the full regression suite locally:

```bash
npm test
```

Keep the suite running while you work:

```bash
npm run test:watch
```

The automated suite covers config generation, daemon HTTP APIs, WebSocket attach/output flow, bus events, session deletion regressions, and CLI smoke tests against a real daemon process.
