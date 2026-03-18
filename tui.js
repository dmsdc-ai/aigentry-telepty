#!/usr/bin/env node

const blessed = require('blessed');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
const { getConfig } = require('./auth');

const PORT = process.env.PORT || 3848;
const DAEMON_URL = `http://localhost:${PORT}`;
const POLL_INTERVAL = 2000;
const STALE_THRESHOLD = 120; // seconds idle before "stale"
const PROJECTS_DIR = path.join(os.homedir(), 'projects');
const DEFAULT_CLI = 'claude --dangerously-skip-permissions';

class TuiDashboard {
  constructor() {
    const cfg = getConfig();
    this.token = cfg.authToken;
    this.sessions = [];
    this.selectedIndex = 0;
    this.pollTimer = null;
    this.busWs = null;
    this.busLog = [];
    this.sessionTasks = {}; // { sessionId: { summary, state, updatedAt } }
    this.setupScreen();
    this.startPolling();
    this.connectBus();
  }

  // ── API helpers ──────────────────────────────────────────────

  async apiFetch(path, options = {}) {
    const headers = { 'x-telepty-token': this.token, ...options.headers };
    if (options.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${DAEMON_URL}${path}`, { ...options, headers });
    return res.json();
  }

  async fetchSessions() {
    try {
      this.sessions = await this.apiFetch('/api/sessions');
      this.sessions.sort((a, b) => a.id.localeCompare(b.id));
      if (this.selectedIndex >= this.sessions.length) {
        this.selectedIndex = Math.max(0, this.sessions.length - 1);
      }
      this.renderSessionList();
    } catch {
      this.setStatus('{red-fg}Daemon unreachable{/}');
    }
  }

  async injectToSession(id, prompt) {
    try {
      const res = await this.apiFetch(`/api/sessions/${encodeURIComponent(id)}/inject`, {
        method: 'POST',
        body: JSON.stringify({ prompt })
      });
      if (res.success) {
        this.setStatus(`{green-fg}Injected to ${id}{/}`);
      } else {
        this.setStatus(`{red-fg}Inject failed: ${res.error || 'unknown'}{/}`);
      }
    } catch (e) {
      this.setStatus(`{red-fg}Inject error: ${e.message}{/}`);
    }
  }

  async broadcastMessage(prompt) {
    try {
      const res = await this.apiFetch('/api/sessions/broadcast/inject', {
        method: 'POST',
        body: JSON.stringify({ prompt })
      });
      const ok = res.results?.successful?.length || 0;
      this.setStatus(`{green-fg}Broadcast to ${ok} sessions{/}`);
    } catch (e) {
      this.setStatus(`{red-fg}Broadcast error: ${e.message}{/}`);
    }
  }

  // ── Session lifecycle (P1) ──────────────────────────────────

  findKittySocket() {
    try {
      const files = fs.readdirSync('/tmp').filter(f => f.startsWith('kitty-sock'));
      return files.length > 0 ? '/tmp/' + files[0] : null;
    } catch { return null; }
  }

  findKittyWindowId(sock, sessionId) {
    try {
      const raw = execSync(`kitty @ --to unix:${sock} ls`, { timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const data = JSON.parse(raw);
      for (const osw of data) {
        for (const tab of osw.tabs) {
          for (const w of tab.windows) {
            for (const p of (w.foreground_processes || [])) {
              const cmd = (p.cmdline || []).join(' ');
              if (cmd.includes('--id ' + sessionId) || cmd.includes('--id=' + sessionId)) {
                return w.id;
              }
            }
            // Also match by window title
            if (w.title && w.title.includes(sessionId)) return w.id;
          }
        }
      }
    } catch {}
    return null;
  }

  discoverProjects() {
    try {
      return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('aigentry-') &&
                fs.existsSync(path.join(PROJECTS_DIR, d.name, '.git')))
        .map(d => ({ name: d.name, cwd: path.join(PROJECTS_DIR, d.name) }));
    } catch { return []; }
  }

  async startSession(project) {
    const sock = this.findKittySocket();
    if (!sock) return this.setStatus('{red-fg}No kitty socket found{/}');

    const cli = DEFAULT_CLI;
    const cliParts = cli.split(' ');
    let teleptyPath, cliPath;
    try { teleptyPath = execSync('which telepty', { encoding: 'utf8' }).trim(); }
    catch { teleptyPath = path.join(__dirname, 'cli.js'); }
    try { cliPath = execSync(`which ${cliParts[0]}`, { encoding: 'utf8' }).trim(); }
    catch { cliPath = cliParts[0]; }
    const cliArgs = cliParts.slice(1).join(' ');
    const nodePath = process.execPath;

    const sessionId = `${project.name}-${cliParts[0]}`;
    const shellCmd = `unset TELEPTY_SESSION_ID; ${nodePath} ${teleptyPath} allow --id ${sessionId} ${cliPath}${cliArgs ? ' ' + cliArgs : ''}`;

    try {
      execFileSync('kitty', ['@', '--to', `unix:${sock}`,
        'launch', '--type=tab', '--tab-title', project.name, '--cwd', project.cwd,
        '--env', 'TELEPTY_SESSION_ID=',
        '--env', `PATH=${process.env.PATH}`,
        '/bin/zsh', '-c', shellCmd
      ], { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
      this.setStatus(`{green-fg}Started ${sessionId}{/}`);
      setTimeout(() => this.fetchSessions(), 2000);
    } catch (e) {
      this.setStatus(`{red-fg}Start failed: ${e.message}{/}`);
    }
  }

  async killSession(id) {
    try {
      // Send Ctrl+C to kitty window first
      const sock = this.findKittySocket();
      if (sock) {
        const wid = this.findKittyWindowId(sock, id);
        if (wid) {
          try {
            execSync(`kitty @ --to unix:${sock} send-text --match id:${wid} $'\\x03'`, {
              timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
            });
          } catch {}
        }
      }
      // Deregister from daemon
      await this.apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      this.setStatus(`{green-fg}Killed ${id}{/}`);
      setTimeout(() => this.fetchSessions(), 1000);
    } catch (e) {
      this.setStatus(`{red-fg}Kill error: ${e.message}{/}`);
    }
  }

  async purgeStale() {
    const staleSessions = this.sessions.filter(s => {
      const idle = s.idleSeconds;
      return (idle !== null && idle > STALE_THRESHOLD) || s.active_clients === 0;
    });
    if (staleSessions.length === 0) {
      return this.setStatus('{yellow-fg}No stale sessions to purge{/}');
    }

    const sock = this.findKittySocket();
    let purged = 0;
    for (const s of staleSessions) {
      try {
        // Send Ctrl+C to the session's kitty window
        if (sock) {
          const wid = this.findKittyWindowId(sock, s.id);
          if (wid) {
            execSync(`kitty @ --to unix:${sock} send-text --match id:${wid} $'\\x03'`, {
              timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
            });
          }
        }
        // Deregister from daemon
        await this.apiFetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
        purged++;
      } catch {}
    }
    this.setStatus(`{green-fg}Purged ${purged}/${staleSessions.length} stale sessions{/}`);
    setTimeout(() => this.fetchSessions(), 1000);
  }

  showProjectPicker() {
    const projects = this.discoverProjects();
    // Filter out projects that already have active sessions
    const activeIds = new Set(this.sessions.map(s => s.id));
    const available = projects.filter(p => {
      const expectedId = `${p.name}-claude`;
      return !activeIds.has(expectedId);
    });

    if (available.length === 0) {
      return this.setStatus('{yellow-fg}All projects already have active sessions{/}');
    }

    const picker = blessed.list({
      parent: this.screen,
      top: 'center', left: 'center',
      width: '50%', height: Math.min(available.length + 2, 20),
      border: { type: 'line' },
      label: ' Start Session — Select Project ',
      tags: true,
      keys: true, vi: true, mouse: true,
      items: available.map(p => ` ${p.name}`),
      style: {
        border: { fg: 'green' },
        selected: { bg: 'green', fg: 'black', bold: true },
        item: { fg: 'white' }
      }
    });

    picker.focus();
    picker.on('select', (item, index) => {
      picker.destroy();
      this.sessionList.focus();
      this.screen.render();
      this.startSession(available[index]);
    });
    picker.key(['escape', 'q'], () => {
      picker.destroy();
      this.sessionList.focus();
      this.screen.render();
    });
    this.screen.render();
  }

  // ── Task extraction from bus events ─────────────────────────

  parseTaskInfo(content) {
    if (!content || typeof content !== 'string') return null;
    const firstLine = content.split('\n')[0].trim();
    // Extract [tag] patterns: [P0 착수], [완료 보고], [telepty 관점], etc.
    const tagMatch = firstLine.match(/\[([^\]]{2,30})\]/);
    const tag = tagMatch ? tagMatch[1] : null;
    // Detect state from keywords
    let state = 'working';
    if (/완료|complete|done|finish/i.test(firstLine)) state = 'done';
    else if (/토론|deliberat|discuss|synthesis|합의/i.test(firstLine)) state = 'discussing';
    else if (/동의|반대|vote|찬성/i.test(firstLine)) state = 'voting';
    else if (/대기|standby|waiting|idle/i.test(firstLine)) state = 'idle';
    // Build summary (tag or truncated first line)
    const summary = tag || firstLine.replace(/\[.*?\]/g, '').trim().slice(0, 30);
    return { summary, state };
  }

  updateSessionTask(sessionId, content) {
    const info = this.parseTaskInfo(content);
    if (!info || !info.summary) return;
    this.sessionTasks[sessionId] = {
      summary: info.summary,
      state: info.state,
      updatedAt: Date.now()
    };
  }

  // ── Event Bus ────────────────────────────────────────────────

  connectBus() {
    try {
      const WebSocket = require('ws');
      this.busWs = new WebSocket(
        `ws://localhost:${PORT}/api/bus?token=${encodeURIComponent(this.token)}`
      );
      this.busWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
          let line = `${ts} `;
          if (msg.type === 'inject_written') {
            line += `{cyan-fg}inject{/} -> ${msg.target || '?'}`;
            // Track task from inject content
            if (msg.target) this.updateSessionTask(msg.target, msg.content || msg.prompt);
          } else if (msg.type === 'injection') {
            line += `{cyan-fg}broadcast{/} -> ${msg.target_agent || 'all'}`;
          } else if (msg.type === 'message_routed') {
            line += `{yellow-fg}${msg.from || '?'}{/} -> {green-fg}${msg.to || '?'}{/}`;
            if (msg.from) this.updateSessionTask(msg.from, msg.content || msg.prompt);
          } else {
            line += `{white-fg}${msg.type || 'event'}{/}`;
          }
          this.busLog.push(line);
          if (this.busLog.length > 100) this.busLog.shift();
          this.renderBusLog();
          this.renderSessionList(); // refresh task info
        } catch { /* ignore malformed */ }
      });
      this.busWs.on('close', () => {
        setTimeout(() => this.connectBus(), 3000);
      });
      this.busWs.on('error', () => {});
    } catch { /* ws not available */ }
  }

  // ── Screen setup ─────────────────────────────────────────────

  setupScreen() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'telepty dashboard',
      fullUnicode: true
    });

    // Header
    this.header = blessed.box({
      parent: this.screen,
      top: 0, left: 0, width: '100%', height: 1,
      tags: true,
      style: { fg: 'white', bg: 'blue' },
      content: ' {bold}telepty dashboard{/bold}'
    });

    // Session list (left panel)
    this.sessionList = blessed.list({
      parent: this.screen,
      top: 1, left: 0, width: '60%', bottom: 3,
      border: { type: 'line' },
      label: ' Sessions ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: { ch: '│', style: { fg: 'cyan' } },
      style: {
        border: { fg: 'cyan' },
        selected: { bg: 'blue', fg: 'white', bold: true },
        item: { fg: 'white' }
      }
    });

    this.sessionList.on('select item', (item, index) => {
      this.selectedIndex = index;
    });

    // Event bus log (right panel)
    this.busPanel = blessed.log({
      parent: this.screen,
      top: 1, left: '60%', right: 0, bottom: 3,
      border: { type: 'line' },
      label: ' Event Bus ',
      tags: true,
      scrollbar: { ch: '│', style: { fg: 'yellow' } },
      style: {
        border: { fg: 'yellow' }
      }
    });

    // Shortcut bar
    this.shortcutBar = blessed.box({
      parent: this.screen,
      bottom: 1, left: 0, width: '100%', height: 1,
      tags: true,
      style: { fg: 'white', bg: 'gray' },
      content: ' {bold}s{/}:Start  {bold}k{/}:Kill  {bold}i{/}:Inject  {bold}b{/}:Broadcast  {bold}p{/}:Purge  {bold}r{/}:Refresh  {bold}q{/}:Quit'
    });

    // Status bar
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 0, left: 0, width: '100%', height: 1,
      tags: true,
      style: { fg: 'white', bg: 'black' },
      content: ' Ready'
    });

    // ── Keyboard handlers ──────────────────────────────────────

    this.screen.key(['q', 'C-c'], () => {
      this.cleanup();
      process.exit(0);
    });

    this.screen.key(['i'], () => {
      const session = this.sessions[this.selectedIndex];
      if (!session) return this.setStatus('{red-fg}No session selected{/}');
      this.promptInput(`Inject to ${session.id}:`, (text) => {
        if (text) this.injectToSession(session.id, text);
      });
    });

    this.screen.key(['b'], () => {
      this.promptInput('Broadcast to all:', (text) => {
        if (text) this.broadcastMessage(text);
      });
    });

    this.screen.key(['r'], () => {
      this.fetchSessions();
      this.setStatus('{green-fg}Refreshed{/}');
    });

    this.screen.key(['s'], () => {
      this.showProjectPicker();
    });

    this.screen.key(['k'], () => {
      const session = this.sessions[this.selectedIndex];
      if (!session) return this.setStatus('{red-fg}No session selected{/}');
      this.killSession(session.id);
    });

    this.screen.key(['p'], () => {
      this.purgeStale();
    });

    this.sessionList.focus();
    this.screen.render();
  }

  // ── Input prompt ─────────────────────────────────────────────

  promptInput(label, callback) {
    const inputBox = blessed.textbox({
      parent: this.screen,
      bottom: 0, left: 0, width: '100%', height: 3,
      border: { type: 'line' },
      label: ` ${label} `,
      tags: true,
      inputOnFocus: true,
      style: {
        border: { fg: 'green' },
        fg: 'white'
      }
    });

    inputBox.focus();
    inputBox.readInput((err, value) => {
      inputBox.destroy();
      this.sessionList.focus();
      this.screen.render();
      if (!err && value) callback(value);
    });
    this.screen.render();
  }

  // ── Rendering ────────────────────────────────────────────────

  getStatusInfo(session) {
    const idle = session.idleSeconds;
    const clients = session.active_clients || 0;
    const task = this.sessionTasks[session.id];
    // Task-aware state (bus events override idle heuristic)
    if (clients === 0) return { icon: '{red-fg}✕{/}', label: '{red-fg}dead{/}' };
    if (idle !== null && idle > STALE_THRESHOLD) return { icon: '{yellow-fg}○{/}', label: '{yellow-fg}stale{/}' };
    if (task && (Date.now() - task.updatedAt) < 300000) { // 5min freshness
      const stateMap = {
        done:       { icon: '{green-fg}✓{/}',  label: '{green-fg}done{/}' },
        discussing: { icon: '{magenta-fg}◉{/}', label: '{magenta-fg}discuss{/}' },
        voting:     { icon: '{magenta-fg}◎{/}', label: '{magenta-fg}vote{/}' },
        working:    { icon: '{cyan-fg}●{/}',    label: '{cyan-fg}working{/}' },
        idle:       { icon: '{green-fg}●{/}',   label: '{white-fg}idle{/}' }
      };
      return stateMap[task.state] || stateMap.working;
    }
    if (idle !== null && idle < 10) return { icon: '{green-fg}●{/}', label: '{green-fg}busy{/}' };
    return { icon: '{green-fg}●{/}', label: '{white-fg}idle{/}' };
  }

  renderSessionList() {
    const items = this.sessions.map((s) => {
      const { icon, label } = this.getStatusInfo(s);
      const shortId = s.id.replace(/^aigentry-/, '').replace(/-claude$/, '');
      const task = this.sessionTasks[s.id];
      const taskStr = (task && (Date.now() - task.updatedAt) < 300000)
        ? ` {gray-fg}${task.summary.slice(0, 20)}{/}` : '';
      return ` ${icon}  ${shortId.padEnd(20)} ${label.padEnd(18)}${taskStr}`;
    });

    this.sessionList.setItems(items);
    this.sessionList.setLabel(` Sessions (${this.sessions.length}) `);
    if (this.selectedIndex < items.length) {
      this.sessionList.select(this.selectedIndex);
    }
    this.screen.render();
  }

  renderBusLog() {
    // Show last N lines that fit
    const height = this.busPanel.height - 2;
    const visible = this.busLog.slice(-height);
    this.busPanel.setContent(visible.join('\n'));
    this.screen.render();
  }

  setStatus(msg) {
    this.statusBar.setContent(` ${msg}`);
    this.screen.render();
  }

  // ── Lifecycle ────────────────────────────────────────────────

  startPolling() {
    this.fetchSessions();
    this.pollTimer = setInterval(() => this.fetchSessions(), POLL_INTERVAL);
  }

  cleanup() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.busWs) this.busWs.close();
    this.screen.destroy();
  }
}

// ── Entry point ──────────────────────────────────────────────────

function main() {
  new TuiDashboard();
}

module.exports = { TuiDashboard };

if (require.main === module) {
  main();
}
