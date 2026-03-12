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

You can also launch the installer through npm without downloading the script first:

```bash
npx --yes @dmsdc-ai/aigentry-telepty@latest
```

*These single commands will install the package globally and automatically configure it to run as a background service specific to your OS (`systemd` for Linux, `launchd` for macOS, or a detached background process for Windows).*
The installer now stops older local telepty daemons before starting the new one, so updates do not leave duplicate background processes behind.

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

If the local daemon ever gets stuck or duplicated, open `telepty` and choose `Repair local daemon`.

## Skill Installation

The package installer opens the telepty skill TUI automatically when you run it in a terminal.

To reopen it later, run `telepty` and choose `Install telepty skills`.

The TUI lets you choose:
- which packaged skills to install
- which target clients to install into (`Claude Code`, `Codex`, `Gemini`)
- whether each target uses a global path, the current project path, or a custom path
