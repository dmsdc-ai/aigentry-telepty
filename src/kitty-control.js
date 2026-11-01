'use strict';

// kitty remote control (`kitty @`). Every call is an argv array — no shell — because the socket
// name comes from a shared /tmp (any local user can create `kitty-sock;<cmd>`) and the session id
// from a WS URL (PR #108 review C3/C4). The socket must also be a real socket owned by this uid,
// so another user's planted file or symlink is never used. `dir`/`fs`/`uid`/`execFileSync` are
// injectable for tests only.

const KITTY_SOCKET_NAME = /^kitty-sock[A-Za-z0-9._-]*$/;

function findKittySocket({ dir = '/tmp', fs = require('fs'), uid = process.getuid && process.getuid() } = {}) {
  if (typeof uid !== 'number') return null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!KITTY_SOCKET_NAME.test(name)) continue;
      const file = `${dir}/${name}`;
      try {
        const st = fs.lstatSync(file);
        if (st.isSocket() && !st.isSymbolicLink() && st.uid === uid) return file;
      } catch {}
    }
  } catch {}
  return null;
}

function kitty(socket, args, { execFileSync = require('child_process').execFileSync, timeout = 3000 } = {}) {
  return execFileSync('kitty', ['@', '--to', `unix:${socket}`, ...args], { timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function findKittyWindowId(socket, sessionId, deps = {}) {
  try {
    const data = JSON.parse(kitty(socket, ['ls'], deps));
    for (const osw of data) {
      for (const tab of osw.tabs) {
        for (const w of tab.windows) {
          // Only check process cmdlines for --id SESSION_ID pattern (not output text)
          for (const p of (w.foreground_processes || [])) {
            const cmd = (p.cmdline || []).join(' ');
            if (cmd.includes('--id ' + sessionId) || cmd.includes('--id=' + sessionId)) {
              return w.id;
            }
          }
        }
      }
    }
  } catch {}
  return null;
}

function setKittyTabTitle(socket, windowId, sessionId, deps = {}) {
  kitty(socket, ['set-tab-title', '--match', `id:${windowId}`, `⚡ telepty :: ${sessionId}`], { timeout: 2000, ...deps });
}

module.exports = { findKittySocket, findKittyWindowId, setKittyTabTitle };
