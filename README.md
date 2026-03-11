# @dmsdc-ai/aigentry-telepty

**Cross-machine PTY-based remote prompt injection daemon for AI CLIs.**

`telepty` (Tele-Prompt) is a lightweight background daemon that bridges the gap between the network and interactive AI command-line interfaces. It allows you to seamlessly share, attach to, and inject commands into terminal sessions across different machines.

## One-Click Installation

To install and set up `telepty` on any machine (macOS, Linux, or Windows):

### The Universal Installer (Windows/macOS/Linux)
Open your terminal (or PowerShell/CMD) and run:
```bash
npx --yes @dmsdc-ai/aigentry-telepty@latest telepty-install
```
*This single command will install the package globally and automatically configure it to run as a background service specific to your OS (`systemd` for Linux, `launchd` for macOS, or a detached background process for Windows).*

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
