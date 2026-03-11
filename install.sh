#!/usr/bin/env bash
set -e

echo "🚀 Installing aigentry-telepty..."
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed. Please install Node.js first."
    exit 1
fi

npm install -g git+https://github.com/dmsdc-ai/aigentry-telepty.git

# Set up systemd service if systemd is available
if command -v systemctl &> /dev/null && [ -d "/etc/systemd/system" ] && [ "$EUID" -eq 0 ]; then
    echo "⚙️ Setting up systemd service..."
    TELEPTY_PATH=$(which telepty)
    cat <<SYSTEMD_EOF > /etc/systemd/system/telepty.service
[Unit]
Description=Telepty Daemon
After=network.target tailscaled.service

[Service]
ExecStart=$TELEPTY_PATH daemon
Restart=always
User=$SUDO_USER
Environment=PATH=/usr/bin:/usr/local/bin:$PATH
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF

    systemctl daemon-reload
    systemctl enable telepty
    systemctl start telepty
    echo "✅ Systemd service installed and started. Daemon will run automatically on boot."
else
    echo "⚠️ Skipping systemd setup (requires root and systemd). Starting daemon in background..."
    nohup telepty daemon > /dev/null 2>&1 &
    echo "✅ Daemon started in background. (Note: It will not auto-start on reboot)"
fi

echo "🎉 Installation complete!"
echo "You can now use 'telepty spawn --id <name> <command>' to create sessions."
