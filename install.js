#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { DEFAULT_PORT, cleanupDaemonProcesses } = require('./daemon-control');

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (e) {
    console.error(`❌ Command failed: ${cmd}`);
    process.exit(1);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function resolveInstalledPackageRoot() {
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return path.join(globalRoot, '@dmsdc-ai', 'aigentry-telepty');
  } catch (e) {
    return __dirname;
  }
}

function resolveDaemonLaunchOptions(options = {}) {
  const packageRoot = options.packageRoot || __dirname;
  const nodeBin = options.nodeBin || process.execPath;
  const cliJs = options.cliJs || path.join(packageRoot, 'cli.js');
  const logDir = options.logDir || path.join(os.homedir(), '.telepty', 'logs');

  return { nodeBin, cliJs, logDir };
}

function cleanupLocalDaemons() {
  console.log('🧹 Cleaning up existing telepty daemons...');
  // #902: service install is machine-wide by contract; the default port is now named, not assumed.
  const results = cleanupDaemonProcesses({ port: DEFAULT_PORT });
  console.log(`   Stopped ${results.stopped.length} daemon(s).`);
  if (results.failed.length > 0) {
    console.warn(`   Could not stop ${results.failed.length} daemon(s).`);
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function uniquePathEntries(entries) {
  const seen = new Set();
  const result = [];

  for (const entry of entries) {
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }

  return result;
}

function buildDaemonPath(nodeBin, baseEntries) {
  return uniquePathEntries([path.dirname(nodeBin), ...baseEntries]).join(':');
}

function systemdExecArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function quoteWindowsArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildLaunchdPlist(options = {}) {
  const label = options.label || 'com.aigentry.telepty';
  const nodeBin = options.nodeBin || process.execPath;
  const cliJs = options.cliJs || path.join(__dirname, 'cli.js');
  const logDir = options.logDir || path.join(os.homedir(), '.telepty', 'logs');
  const command = options.command || 'daemon';
  const daemonPath = buildDaemonPath(nodeBin, ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  const stdoutPath = path.join(logDir, 'launchd.out.log');
  const stderrPath = path.join(logDir, 'launchd.err.log');
  const envPairs = [['PATH', daemonPath], ...Object.entries(options.extraEnv || {})];
  const envXml = envPairs
    .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(nodeBin)}</string>
        <string>${escapeXml(cliJs)}</string>
        <string>${escapeXml(command)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrPath)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>`;
}

function systemdEnvLine(key, value) {
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `Environment="${key}=${escaped}"`;
}

function buildSystemdService(options = {}) {
  const nodeBin = options.nodeBin || process.execPath;
  const cliJs = options.cliJs || path.join(__dirname, 'cli.js');
  const user = options.user;
  const userLine = user ? `User=${user}\n` : '';
  const daemonPath = buildDaemonPath(nodeBin, ['/usr/local/bin', '/usr/bin', '/bin']);
  const wantedBy = options.wantedBy || 'multi-user.target';
  const command = options.command || 'daemon';
  const description = options.description || 'Telepty Daemon';
  const extraEnvLines = Object.entries(options.extraEnv || {})
    .map(([key, value]) => `${systemdEnvLine(key, value)}\n`)
    .join('');

  return `[Unit]
Description=${description}
After=network.target

[Service]
ExecStart=${systemdExecArg(nodeBin)} ${systemdExecArg(cliJs)} ${systemdExecArg(command)}
Restart=always
${userLine}Environment=PATH=${daemonPath}
Environment=NODE_ENV=production
${extraEnvLines}
[Install]
WantedBy=${wantedBy}`;
}

function buildWindowsAutostartCommand(options = {}) {
  const nodeBin = options.nodeBin || process.execPath;
  const cliJs = options.cliJs || path.join(__dirname, 'cli.js');
  const taskName = options.taskName || 'telepty-daemon';
  const command = options.command || 'daemon';
  const taskCommand = `${quoteWindowsArg(nodeBin)} ${quoteWindowsArg(cliJs)} ${command}`;

  return `schtasks /create /tn ${quoteWindowsArg(taskName)} /sc onlogon /rl LIMITED /f /tr ${quoteWindowsArg(taskCommand)}`;
}

function buildWindowsRunTaskCommand(options = {}) {
  const taskName = options.taskName || 'telepty-daemon';
  return `schtasks /run /tn ${quoteWindowsArg(taskName)}`;
}

function buildWindowsQueryTaskCommand(options = {}) {
  const taskName = options.taskName || 'telepty-daemon';
  return `schtasks /query /tn ${quoteWindowsArg(taskName)} /fo LIST`;
}

// Resolve the service profile main() installs (the exact pre-#42 daemon values).
function resolveServiceProfile() {
  return {
    command: 'daemon',
    launchdLabel: 'com.aigentry.telepty',
    launchdPlistName: 'com.aigentry.telepty.plist',
    systemdService: 'telepty',
    windowsTask: 'telepty-daemon',
    description: 'Telepty Daemon',
    extraEnv: {},
  };
}

function assertLaunchdServiceLive(label = 'com.aigentry.telepty') {
  let output = '';
  try {
    output = execSync(`launchctl list ${shellQuote(label)}`, { encoding: 'utf8' });
  } catch (e) {
    throw new Error(`launchd service ${label} was not found after load`);
  }

  const pidMatch = output.match(/"PID"\s*=\s*([0-9]+)/);
  if (!pidMatch || Number(pidMatch[1]) <= 0) {
    throw new Error(`launchd service ${label} loaded but has no live PID. launchctl output:\n${output}`);
  }
}

function assertSystemdServiceLive(serviceName = 'telepty', options = {}) {
  const scope = options.user ? '--user ' : '';
  try {
    execSync(`systemctl ${scope}is-active --quiet ${serviceName}`, { stdio: 'ignore' });
  } catch (e) {
    throw new Error(`systemd service ${serviceName} is not active after start`);
  }
}

function assertWindowsTaskRunning(taskName = 'telepty-daemon') {
  let output = '';
  try {
    output = execSync(buildWindowsQueryTaskCommand({ taskName }), { encoding: 'utf8' });
  } catch (e) {
    throw new Error(`Windows scheduled task ${taskName} was not found after creation`);
  }

  if (!/^Status:\s*Running$/im.test(output)) {
    throw new Error(`Windows scheduled task ${taskName} started but is not running. schtasks output:\n${output}`);
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
    const { runInteractiveSkillInstaller } = require('./skill-installer');
    await runInteractiveSkillInstaller({
      packageRoot: resolveInstalledPackageRoot(),
      cwd: process.cwd()
    });
  } catch (e) {
    console.warn('⚠️ Could not install telepty skills:', e.message);
  }
}

async function main() {
  console.log("🚀 Installing @dmsdc-ai/aigentry-telepty...");

  const profile = resolveServiceProfile();

  // 1. Install globally via npm
  console.log("📦 Installing package globally...");
  run("npm install -g @dmsdc-ai/aigentry-telepty");

  // 2. Install telepty skills for supported clients
  await installSkills();

  // 3. Resolve daemon entrypoint without relying on service-manager PATH.
  const launchOptions = resolveDaemonLaunchOptions({ packageRoot: resolveInstalledPackageRoot() });
  if (!fs.existsSync(launchOptions.cliJs)) {
    throw new Error(`Cannot find daemon entrypoint: ${launchOptions.cliJs}`);
  }

  // 4. Setup OS-specific autostart or background daemon
  const platform = os.platform();

  if (platform === 'win32') {
    cleanupLocalDaemons();
    console.log("⚙️ Setting up Windows scheduled task...");
    run(buildWindowsAutostartCommand({ ...launchOptions, taskName: profile.windowsTask, command: profile.command }));
    run(buildWindowsRunTaskCommand({ taskName: profile.windowsTask }));
    assertWindowsTaskRunning(profile.windowsTask);
    console.log("✅ Windows scheduled task installed and started.");

  } else if (platform === 'darwin') {
    console.log("⚙️ Setting up macOS launchd service...");
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', profile.launchdPlistName);
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.mkdirSync(launchOptions.logDir, { recursive: true });
    try { execSync(`launchctl unload ${shellQuote(plistPath)} 2>/dev/null`); } catch(e){}
    cleanupLocalDaemons();

    const plistContent = buildLaunchdPlist({
      ...launchOptions,
      label: profile.launchdLabel,
      command: profile.command,
      extraEnv: profile.extraEnv,
    });

    fs.writeFileSync(plistPath, plistContent);
    run(`launchctl load ${shellQuote(plistPath)}`);
    assertLaunchdServiceLive(profile.launchdLabel);
    console.log("✅ macOS LaunchAgent installed and started.");

  } else {
    // Linux
    let hasSystemd = false;
    try {
      execSync('systemctl --version', { stdio: 'ignore' });
      hasSystemd = true;
    } catch(e) {}

    if (hasSystemd) {
      if (process.getuid && process.getuid() === 0) {
        console.log("⚙️ Setting up systemd service for Linux...");
        try { execSync(`systemctl stop ${profile.systemdService}`, { stdio: 'ignore' }); } catch(e) {}
        cleanupLocalDaemons();
        const serviceContent = buildSystemdService({
          ...launchOptions,
          user: process.env.SUDO_USER || process.env.USER || 'root',
          command: profile.command,
          description: profile.description,
          extraEnv: profile.extraEnv,
        });

        fs.writeFileSync(`/etc/systemd/system/${profile.systemdService}.service`, serviceContent);
        run('systemctl daemon-reload');
        run(`systemctl enable ${profile.systemdService}`);
        run(`systemctl start ${profile.systemdService}`);
        assertSystemdServiceLive(profile.systemdService);
        console.log("✅ Systemd service installed and started.");
        process.exit(0);
      }

      console.log("⚙️ Setting up user systemd service for Linux...");
      const userServicePath = path.join(os.homedir(), '.config', 'systemd', 'user', `${profile.systemdService}.service`);
      fs.mkdirSync(path.dirname(userServicePath), { recursive: true });
      cleanupLocalDaemons();
      fs.writeFileSync(userServicePath, buildSystemdService({
        ...launchOptions,
        wantedBy: 'default.target',
        command: profile.command,
        description: profile.description,
        extraEnv: profile.extraEnv,
      }));
      run('systemctl --user daemon-reload');
      run(`systemctl --user enable ${profile.systemdService}`);
      run(`systemctl --user start ${profile.systemdService}`);
      assertSystemdServiceLive(profile.systemdService, { user: true });
      console.log("✅ User systemd service installed and started.");
      process.exit(0);
    }

    // Fallback for Linux without systemd
    console.log("⚠️ Skipping persistent systemd setup. Starting daemon for this session only...");
    cleanupLocalDaemons();
    const subprocess = spawn(launchOptions.nodeBin, [launchOptions.cliJs, profile.command], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...profile.extraEnv }
    });
    subprocess.unref();
    console.log("✅ Linux daemon started in background for the current session.");
  }

  console.log("\n🎉 Installation complete! Telepty daemon is running.");
  console.log("👉 Try running: telepty attach\n");
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ Installation failed:', e.message);
    process.exit(1);
  });
}

module.exports = {
  buildLaunchdPlist,
  buildSystemdService,
  buildWindowsAutostartCommand,
  resolveDaemonLaunchOptions,
  resolveServiceProfile,
};
