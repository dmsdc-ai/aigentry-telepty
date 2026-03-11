# @dmsdc-ai/aigentry-telepty

**Cross-machine PTY-based remote prompt injection daemon for AI CLIs.**

`telepty` (Tele-Prompt) is a lightweight background daemon that bridges the gap between the network and interactive AI command-line interfaces. It allows you to seamlessly share, attach to, and inject commands into terminal sessions across different machines.

## One-Click Installation

To install and set up `telepty` on any machine (macOS, Linux, or Windows):

### Option 1: Quick Install Script (Linux/macOS)
This script installs the package globally and sets it up as a background service (if `systemd` is available).
```bash
curl -s https://raw.githubusercontent.com/dmsdc-ai/aigentry-telepty/main/install.sh | sudo bash
```

### Option 2: via NPM
```bash
npm install -g @dmsdc-ai/aigentry-telepty
telepty daemon &
```

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
