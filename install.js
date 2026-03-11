#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { runInteractiveSkillInstaller } = require('./skill-installer');

console.log("🚀 Installing @dmsdc-ai/aigentry-telepty...");

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (e) {
    console.error(`❌ Command failed: ${cmd}`);
    process.exit(1);
  }
}

function resolveInstalledPackageRoot() {
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return path.join(globalRoot, '@dmsdc-ai', 'aigentry-telepty');
  } catch (e) {
    return __dirname;
  }
}

async function installSkills() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('⏭️  Skipping interactive skill installation (no TTY).');
    console.log('   Run `telepty` later and choose "Install telepty skills".');
    return;
  }

  console.log('\n📋 Telepty skill installation');

  try {
    await runInteractiveSkillInstaller({
      packageRoot: resolveInstalledPackageRoot(),
      cwd: process.cwd()
    });
  } catch (e) {
    console.warn('⚠️ Could not install telepty skills:', e.message);
  }
}

(async () => {
  // 1. Install globally via npm
  console.log("📦 Installing package globally...");
  run("npm install -g @dmsdc-ai/aigentry-telepty");

  // 2. Install telepty skills for supported clients
  await installSkills();

  // 3. Find executable
  let teleptyPath = '';
  try {
    teleptyPath = execSync(os.platform() === 'win32' ? 'where telepty' : 'which telepty', { encoding: 'utf8' }).split('\n')[0].trim();
  } catch (e) {
    teleptyPath = 'telepty'; // fallback
  }

  // 4. Setup OS-specific autostart or background daemon
  const platform = os.platform();

  if (platform === 'win32') {
    console.log("⚙️ Setting up Windows background process...");
    const subprocess = spawn(teleptyPath, ['daemon'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    subprocess.unref();
    console.log("✅ Windows daemon started in background.");

  } else if (platform === 'darwin') {
    console.log("⚙️ Setting up macOS launchd service...");
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.aigentry.telepty.plist');
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aigentry.telepty</string>
    <key>ProgramArguments</key>
    <array>
        <string>${teleptyPath}</string>
        <string>daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>`;

    fs.writeFileSync(plistPath, plistContent);
    try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`); } catch(e){}
    run(`launchctl load "${plistPath}"`);
    console.log("✅ macOS LaunchAgent installed and started.");

  } else {
    // Linux
    try {
      execSync('systemctl --version', { stdio: 'ignore' });
      if (process.getuid && process.getuid() === 0) {
        console.log("⚙️ Setting up systemd service for Linux...");
        const serviceContent = `[Unit]
Description=Telepty Daemon
After=network.target

[Service]
ExecStart=${teleptyPath} daemon
Restart=always
User=${process.env.SUDO_USER || process.env.USER || 'root'}
Environment=PATH=/usr/bin:/usr/local/bin:$PATH
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target`;

        fs.writeFileSync('/etc/systemd/system/telepty.service', serviceContent);
        run('systemctl daemon-reload');
        run('systemctl enable telepty');
        run('systemctl start telepty');
        console.log("✅ Systemd service installed and started.");
        process.exit(0);
      }
    } catch(e) {}

    // Fallback for Linux without systemd or non-root
    console.log("⚠️ Skipping systemd (no root or no systemd). Starting in background...");
    const subprocess = spawn(teleptyPath, ['daemon'], {
      detached: true,
      stdio: 'ignore'
    });
    subprocess.unref();
    console.log("✅ Linux daemon started in background using nohup equivalent.");
  }

  console.log("\n🎉 Installation complete! Telepty daemon is running.");
  console.log("👉 Try running: telepty attach\n");
})();
