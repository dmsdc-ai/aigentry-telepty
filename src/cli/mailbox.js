'use strict';

async function runMailboxCommand(argv, { daemonUrl, fetchWithAuth, fetch = globalThis.fetch,
  sessionToken = process.env.TELEPTY_SESSION_TOKEN, log = console.log, error = console.error,
  fail = () => { process.exitCode = 1; } }) {
  const ack = argv[0] === 'ack';
  const sid = argv[ack ? 1 : 0];
  const msgId = ack ? argv[2] : null;
  if (!sid || sid.startsWith('-') || (ack && !msgId)) {
    error('Usage: telepty mailbox <session_id> [--json] [--since <msg_id>] | telepty mailbox ack <session_id> <msg_id>');
    fail(); return;
  }
  const sinceIndex = argv.indexOf('--since');
  if (sinceIndex !== -1 && !argv[sinceIndex + 1]) {
    error('--since requires a message id.'); fail(); return;
  }
  const url = new URL(`/api/sessions/${encodeURIComponent(sid)}/mailbox${ack ? '/ack' : ''}`, daemonUrl);
  if (!ack && sinceIndex !== -1) url.searchParams.set('since', argv[sinceIndex + 1]);
  const options = ack ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_id: msgId }) } : {};
  try {
    // The mailbox bearer is sufficient for these two narrow operations. Avoid loading
    // the shared daemon credential when the confined poller already has its own bearer.
    const response = sessionToken
      ? await fetch(url.toString(), { ...options, headers: { ...options.headers, 'x-telepty-session-token': sessionToken } })
      : await fetchWithAuth(url.toString(), options);
    const data = await response.json();
    if (!response.ok) { error(`Mailbox request failed (${response.status}): ${data.code || 'REQUEST_FAILED'}`); fail(); return; }
    if (argv.includes('--json') || ack) log(JSON.stringify(data, null, 2));
    else for (const msg of data.pending || []) log(`${msg.msg_id}\t${msg.from}\t${msg.payload}`);
  } catch {
    // Transport exceptions can contain request headers in third-party implementations.
    error('Mailbox request failed.'); fail();
  }
}

module.exports = { runMailboxCommand };
