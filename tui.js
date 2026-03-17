#!/usr/bin/env node

const blessed = require('blessed');
const { getConfig } = require('./auth');

const PORT = process.env.PORT || 3848;
const DAEMON_URL = `http://localhost:${PORT}`;
const POLL_INTERVAL = 2000;
const STALE_THRESHOLD = 120; // seconds idle before "stale"

class TuiDashboard {
  constructor() {
    const cfg = getConfig();
    this.token = cfg.authToken;
    this.sessions = [];
    this.selectedIndex = 0;
    this.pollTimer = null;
    this.busWs = null;
    this.busLog = [];
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
          } else if (msg.type === 'injection') {
            line += `{cyan-fg}broadcast{/} -> ${msg.target_agent || 'all'}`;
          } else if (msg.type === 'message_routed') {
            line += `{yellow-fg}${msg.from || '?'}{/} -> {green-fg}${msg.to || '?'}{/}`;
          } else {
            line += `{white-fg}${msg.type || 'event'}{/}`;
          }
          this.busLog.push(line);
          if (this.busLog.length > 100) this.busLog.shift();
          this.renderBusLog();
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
      content: ' {bold}i{/}:Inject  {bold}b{/}:Broadcast  {bold}r{/}:Refresh  {bold}q{/}:Quit'
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

    if (clients === 0) return { icon: '{red-fg}✕{/}', label: '{red-fg}dead{/}' };
    if (idle !== null && idle > STALE_THRESHOLD) return { icon: '{yellow-fg}○{/}', label: '{yellow-fg}stale{/}' };
    if (idle !== null && idle < 10) return { icon: '{green-fg}●{/}', label: '{green-fg}busy{/}' };
    return { icon: '{green-fg}●{/}', label: '{white-fg}idle{/}' };
  }

  renderSessionList() {
    const items = this.sessions.map((s) => {
      const { icon, label } = this.getStatusInfo(s);
      const shortId = s.id.replace(/^aigentry-/, '').replace(/-claude$/, '');
      return ` ${icon}  ${shortId.padEnd(24)} ${label}  {gray-fg}C:${s.active_clients}{/}`;
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
