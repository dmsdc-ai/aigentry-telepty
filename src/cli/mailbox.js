'use strict';
const { routingError } = require('../../session-routing');
const { scopedSessionToken } = require('./security-actions');

async function runMailboxCommand(argv, { daemonUrl, fetchWithAuth, resolveTarget, targetUrl, fetch = globalThis.fetch,
  sessionToken = process.env.TELEPTY_SESSION_TOKEN, sessionOrigin = process.env.TELEPTY_SESSION_ORIGIN, log = console.log, error = console.error,
  fail = () => { process.exitCode = 1; } }) {
  const json = argv.includes('--json');
  const refuse = (code, message) => {
    if (json) log(JSON.stringify({ success: false, code, error: message }));
    error(message);
    fail();
  };
  const ack = argv[0] === 'ack';
  const sid = argv[ack ? 1 : 0];
  const msgId = ack ? argv[2] : null;
  if (!sid || sid.startsWith('-') || (ack && !msgId)) {
    refuse('INVALID_MAILBOX_ARGUMENTS', 'Usage: telepty mailbox <session_id> [--json] [--since <msg_id>] | telepty mailbox ack <session_id> <msg_id>'); return;
  }
  const sinceIndex = argv.indexOf('--since');
  if (sinceIndex !== -1 && !argv[sinceIndex + 1]) {
    refuse('INVALID_MAILBOX_ARGUMENTS', '--since requires a message id.'); return;
  }
  const options = ack ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_id: msgId }) } : {};
  let target;
  try {
    target = resolveTarget ? await resolveTarget(sid) : { id: sid };
    if (!target) throw routingError('INVALID_SESSION_REFERENCE', 'A mailbox id is required.');
    if (target.remote) throw routingError('UNSUPPORTED_SESSION_TRANSPORT', 'Mailbox requires an HTTP daemon endpoint.');
  } catch (e) {
    refuse(e.code || 'MAILBOX_TARGET_FAILED', e.message); return;
  }
  try {
    const base = target.host ? targetUrl(target.host) : daemonUrl;
    const url = new URL(`/api/sessions/${encodeURIComponent(target.id)}/mailbox${ack ? '/ack' : ''}`, base);
    if (!ack && sinceIndex !== -1) url.searchParams.set('since', argv[sinceIndex + 1]);
    // The mailbox bearer is sufficient for these two narrow operations. Avoid loading
    // the shared daemon credential when the confined poller already has its own bearer.
    const scoped = sessionToken && scopedSessionToken(url.toString(), {
      env: { TELEPTY_SESSION_TOKEN: sessionToken, TELEPTY_SESSION_ORIGIN: sessionOrigin },
      localOrigin: `http://127.0.0.1:${new URL(daemonUrl).port || 3848}`
    });
    if (sessionToken && !scoped) throw new Error('Mailbox credential belongs to another daemon origin.');
    const response = scoped
      ? await fetch(url.toString(), { ...options, redirect: 'error', headers: { ...options.headers, 'x-telepty-session-token': scoped } })
      : await fetchWithAuth(url.toString(), options);
    const data = await response.json();
    if (!response.ok) { refuse(data.code || 'REQUEST_FAILED', `Mailbox request failed (${response.status}): ${data.code || 'REQUEST_FAILED'}`); return; }
    if (argv.includes('--json') || ack) log(JSON.stringify(data, null, 2));
    else for (const msg of data.pending || []) log(`${msg.msg_id}\t${msg.from}\t${msg.payload}`);
  } catch {
    // Transport exceptions can contain request headers in third-party implementations.
    refuse('MAILBOX_REQUEST_FAILED', 'Mailbox request failed.');
  }
}

module.exports = { runMailboxCommand };
