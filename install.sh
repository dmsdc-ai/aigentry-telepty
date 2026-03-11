#!/usr/bin/env bash
set -e

echo "🚀 Installing @dmsdc-ai/aigentry-telepty..."

# 1. Check if Node.js/npm is installed
if ! command -v npm &> /dev/null; then
    echo "⚠️ npm is not found. Attempting to install Node.js..."
    if command -v curl &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    elif command -v wget &> /dev/null; then
        wget -qO- https://deb.nodesource.com/setup_20.x | sudo -E bash -
    else
        echo "❌ Error: Neither curl nor wget is found. Please install Node.js manually."
        exit 1
    fi
    sudo apt-get install -y nodejs || sudo yum install -y nodejs || sudo dnf install -y nodejs || sudo pacman -S -y nodejs || brew install node
fi

# 2. Install the package globally via npm registry instead of git (more stable for public users)
echo "📦 Installing package globally..."
sudo npm install -g @dmsdc-ai/aigentry-telepty

# Find the executable path
TELEPTY_PATH=$(which telepty || npx which telepty)

# 3. Setup auto-start daemon based on OS / Init system
if command -v systemctl &> /dev/null && [ -d "/etc/systemd/system" ] && [ "$EUID" -eq 0 ]; then
    # Modern Linux (systemd)
    echo "⚙️ Setting up systemd service for Linux..."
    cat <<SYSTEMD_EOF > /etc/systemd/system/telepty.service
[Unit]
Description=Telepty Daemon
After=network.target

[Service]
ExecStart=$TELEPTY_PATH daemon
Restart=always
User=${SUDO_USER:-$USER}
Environment=PATH=/usr/bin:/usr/local/bin:$PATH
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF

    systemctl daemon-reload
    systemctl enable telepty
    systemctl start telepty
    echo "✅ Systemd service installed and started."

elif [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS (launchd)
    echo "⚙️ Setting up launchd service for macOS..."
    PLIST_PATH="$HOME/Library/LaunchAgents/com.aigentry.telepty.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    
    cat <<PLIST_EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aigentry.telepty</string>
    <key>ProgramArguments</key>
    <array>
        <string>$TELEPTY_PATH</string>
        <string>daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
PLIST_EOF

    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
    echo "✅ macOS LaunchAgent installed and started."

else
    # Fallback for Windows (WSL), Termux, or non-root Linux without systemd
    echo "⚠️ Skipping OS-level service setup. Starting daemon in background..."
    nohup $TELEPTY_PATH daemon > /dev/null 2>&1 &
    echo "✅ Daemon started in background. (Will not auto-start on reboot)"
fi

echo "🎉 Installation complete! Telepty daemon is running."
echo "👉 Try running: telepty attach"
