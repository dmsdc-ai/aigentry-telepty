#!/usr/bin/env bash
set -e

echo "🚀 Installing @dmsdc-ai/aigentry-telepty..."

# 1. Check for Node.js and install if missing
if ! command -v npm &> /dev/null; then
    echo "⚠️ Node.js/npm not found. Attempting to install Node.js..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if ! command -v brew &> /dev/null; then
            echo "❌ Homebrew not found. Please install Node.js manually: https://nodejs.org/"
            exit 1
        fi
        brew install node
    elif command -v apt-get &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif command -v yum &> /dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo yum install -y nodejs
    elif command -v dnf &> /dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo dnf install -y nodejs
    elif command -v pacman &> /dev/null; then
        sudo pacman -Sy nodejs npm --noconfirm
    elif command -v pkg &> /dev/null; then
        # Termux environment
        pkg install -y nodejs
    else
        echo "❌ Could not determine package manager. Please install Node.js manually: https://nodejs.org/"
        exit 1
    fi
fi

# 2. Install telepty via npm
echo "📦 Installing telepty globally..."
if [[ "$OSTYPE" == "darwin"* ]] || command -v pkg &> /dev/null || [ "$EUID" -eq 0 ]; then
    npm install -g @dmsdc-ai/aigentry-telepty
else
    # Linux non-root might need sudo for global install depending on npm setup
    sudo npm install -g @dmsdc-ai/aigentry-telepty || npm install -g @dmsdc-ai/aigentry-telepty
fi

TELEPTY_PATH=$(which telepty || true)
if [ -z "$TELEPTY_PATH" ]; then
    TELEPTY_PATH="$(npm prefix -g)/bin/telepty"
fi

# 3. Setup Daemon
echo "⚙️ Setting up daemon..."
if command -v systemctl &> /dev/null && [ -d "/etc/systemd/system" ]; then
    if [ "$EUID" -ne 0 ]; then
        echo "⚠️  systemd requires root to install service. Prompting for sudo..."
        SUDO_CMD="sudo"
    else
        SUDO_CMD=""
    fi

    $SUDO_CMD systemctl stop telepty 2>/dev/null || true
    "$TELEPTY_PATH" cleanup-daemons >/dev/null 2>&1 || true

    $SUDO_CMD bash -c "cat <<EOF > /etc/systemd/system/telepty.service
[Unit]
Description=Telepty Daemon
After=network.target

[Service]
ExecStart=$TELEPTY_PATH daemon
Restart=always
User=${SUDO_USER:-$USER}
Environment=PATH=/usr/bin:/usr/local/bin:\$PATH
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF"

    $SUDO_CMD systemctl daemon-reload
    $SUDO_CMD systemctl enable telepty
    $SUDO_CMD systemctl start telepty
    echo "✅ Linux systemd service installed and started. (Auto-starts on boot)"

elif [[ "$OSTYPE" == "darwin"* ]]; then
    PLIST_PATH="$HOME/Library/LaunchAgents/com.aigentry.telepty.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    "$TELEPTY_PATH" cleanup-daemons >/dev/null 2>&1 || true
    cat <<EOF > "$PLIST_PATH"
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
EOF
    launchctl load "$PLIST_PATH"
    echo "✅ macOS LaunchAgent installed and started. (Auto-starts on boot)"
else
    echo "⚠️ Skipping OS-level service setup (Termux or missing systemd). Starting in background..."
    "$TELEPTY_PATH" cleanup-daemons >/dev/null 2>&1 || true
    nohup $TELEPTY_PATH daemon > /dev/null 2>&1 &
    echo "✅ Daemon started in background. (Note: Will not auto-start on device reboot)"
fi

echo ""
echo "🎉 Installation complete! Telepty daemon is running in the background."
echo "👉 Try running: telepty attach"
echo "👉 Optional: run telepty and choose 'Install telepty skills' to add skills for Claude Code, Codex, or Gemini"
