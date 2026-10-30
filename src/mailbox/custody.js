'use strict';
// A strict, bounded read used only at an explicit authority transfer. Normal delivery retains
// its existing tolerant readers; a custody receipt must not turn corruption into an empty queue.
const fs = require('node:fs');
const path = require('node:path');
const { openFile } = require('./path-boundary');
const { parseUnambiguousJSON } = require('../principal/encoding');
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 20000;
function invalid() { throw Object.assign(new Error('Mailbox custody is unavailable'), { code: 'MAILBOX_CUSTODY_UNAVAILABLE' }); }
function readStrict(file) {
    const fd = openFile(file, fs.constants.O_RDONLY);
    try {
        const stat = fs.fstatSync(fd);
        if (stat.size > MAX_FILE_BYTES)
            invalid();
        const bytes = Buffer.alloc(stat.size + 1);
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        const after = fs.fstatSync(fd);
        if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
            invalid();
        const text = bytes.subarray(0, count).toString('utf8');
        if (!Buffer.from(text).equals(bytes.subarray(0, count)) || (text && !text.endsWith('\n')))
            invalid();
        const lines = text.split('\n').filter(line => line.trim());
        if (lines.length > MAX_ROWS)
            invalid();
        return lines.map(line => parseUnambiguousJSON(line));
    }
    finally {
        fs.closeSync(fd);
    }
}
function boundedId(value) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 128 && !/[\x00-\x1f\x7f]/.test(value); }
function readCustody(directory, sessionId, { compaction = false } = {}) {
    // Both files must exist, even for an initialized empty queue. A missing component cannot
    // establish that a queue was empty rather than partly lost or never initialized.
    const inbox = readStrict(path.join(directory, 'inbox.jsonl'));
    const journal = readStrict(path.join(directory, 'state.jsonl'));
    const messages = new Map(), states = new Map(), inboxCounts = new Map(), histories = new Map();
    for (const row of inbox) {
        inboxCounts.set(row?.msg_id, (inboxCounts.get(row?.msg_id) || 0) + 1);
        if (!row || !boundedId(row.msg_id) || row.to !== sessionId || typeof row.payload !== 'string'
            || !Number.isSafeInteger(row.created_at) || row.created_at < 0
            || (row.from != null && (typeof row.from !== 'string' || Buffer.byteLength(row.from) > 512))
            || !Number.isSafeInteger(row.attempt) || row.attempt < 0
            || Object.keys(row).some(key => !['msg_id', 'to', 'from', 'payload', 'created_at', 'attempt', 'cooperative_handoff'].includes(key)))
            invalid();
        const previous = messages.get(row.msg_id);
        if (previous && (previous.payload !== row.payload || previous.from !== row.from || (previous.created_at !== row.created_at && !(compaction && row.attempt > previous.attempt && row.attempt > 0))))
            invalid();
        if (!previous || row.attempt >= previous.attempt)
            messages.set(row.msg_id, row);
    }
    for (const row of journal) {
        if (!row || !boundedId(row.msg_id) || !['pending', 'in_flight', 'acked', 'nacked', 'expired', 'dead_letter'].includes(row.state)
            || !Number.isSafeInteger(row.ts) || row.ts < 0 || !messages.has(row.msg_id)
            || Object.keys(row).some(key => !['msg_id', 'state', 'ts', 'attempt', 'never_attempted', 'non_retryable_attempt', 'delivery_uncertain', 'outcome', 'retryable'].includes(key)))
            invalid();
        if ((row.never_attempted !== undefined && (row.never_attempted !== true || row.state !== 'pending'))
            || (row.non_retryable_attempt !== undefined && (row.non_retryable_attempt !== true || row.state !== 'in_flight'))
            || (row.delivery_uncertain !== undefined && (row.delivery_uncertain !== true || row.state !== 'dead_letter' || row.outcome !== 'unknown' || row.retryable !== false))
            || ((row.outcome !== undefined || row.retryable !== undefined) && row.delivery_uncertain !== true)
            || (row.attempt !== undefined && (!Number.isSafeInteger(row.attempt) || row.attempt < 0)))
            invalid();
        if (!histories.has(row.msg_id))
            histories.set(row.msg_id, []);
        histories.get(row.msg_id).push(row);
        states.set(row.msg_id, row);
    }
    // Explicit unknown outcomes survive later labels. An attempt fence alone may
    // be settled by the normal known terminal result; neither establishes consumption.
    let unsettled = journal.some(row => row.delivery_uncertain === true || row.outcome === 'unknown' || row.retryable === false);
    for (const [id, history] of histories) {
        if (history.some(row => row.non_retryable_attempt === true) && !['acked', 'expired', 'dead_letter'].includes(states.get(id)?.state))
            unsettled = true;
    }
    const deadLetter = path.join(directory, 'dead-letter.jsonl');
    if (fs.existsSync(deadLetter) && readStrict(deadLetter).some(row => row.delivery_uncertain === true || row.outcome === 'unknown' || row.retryable === false || /unknown|uncertain/i.test(String(row.reason || ''))))
        unsettled = true;
    return { inbox, journal, messages, states, inboxCounts, histories, unsettled };
}
function strictCustodySnapshot(directory, sessionId) {
    const { messages, states, unsettled } = readCustody(directory, sessionId);
    if (unsettled)
        invalid();
    const pending = [];
    for (const [id, message] of messages) {
        const state = states.get(id);
        if (!state || state.state === 'nacked')
            invalid();
        if (['pending', 'in_flight'].includes(state.state))
            pending.push({ msg_id: id, from: message.from || null,
                created_at: message.created_at, state: state.state, attempt: message.attempt });
    }
    return pending;
}
function neverAttemptedCustodySnapshot(directory, sessionId) {
    const { messages, states, inboxCounts, histories, unsettled } = readCustody(directory, sessionId), result = [];
    if (unsettled)
        invalid();
    for (const [id, message] of messages) {
        const state = states.get(id);
        if (!state)
            invalid();
        if (['acked', 'expired', 'dead_letter'].includes(state.state))
            continue;
        const history = histories.get(id) || [];
        if (state.state !== 'pending' || message.attempt !== 0 || inboxCounts.get(id) !== 1 || history.length !== 1 || history[0].never_attempted !== true || history[0].non_retryable_attempt || history[0].attempt || Object.keys(history[0]).some(key => !['msg_id', 'state', 'ts', 'never_attempted', 'attempt'].includes(key)))
            invalid();
        result.push({ ...message, from: message.from || null });
        if (result.length > require('../principal/pending-handoff').MAX_PENDING)
            invalid();
    }
    if (result.length > require('../principal/pending-handoff').MAX_PENDING)
        invalid();
    return result;
}
function pristinePendingIds(directory, sessionId) {
    const { messages, states, inboxCounts, histories } = readCustody(directory, sessionId, { compaction: true }), ids = new Set();
    for (const [id, message] of messages) {
        const history = histories.get(id) || [];
        if (states.get(id)?.state === 'pending' && message.attempt === 0 && inboxCounts.get(id) === 1 && history.length === 1 && history[0].never_attempted === true)
            ids.add(id);
    }
    return ids;
}
function acknowledgedCustodySnapshot(directory, sessionId, event) {
    const { messages, states, unsettled } = readCustody(directory, sessionId);
    if (unsettled) invalid();
    const digest = require('../principal/encoding').bodyDigest;
    const missing = [];
    for (const record of event.pending_records) {
        const present = messages.has(record.id) || states.has(record.id);
        if (present) {
            if (states.get(record.id)?.state !== 'acked' || !messages.has(record.id) || digest(messages.get(record.id)) !== record.digest) invalid();
        } else missing.push(record);
    }
    if (missing.length) {
        const settlement = require('./handoff-settlement');
        const confirmed = settlement.readSettlements(directory, {sync:true});
        if (!missing.every(record => settlement.confirmed(confirmed, sessionId, event, record))) invalid();
    }
    return true;
}
module.exports = { readCustody, acknowledgedCustodySnapshot, strictCustodySnapshot, neverAttemptedCustodySnapshot, pristinePendingIds, MAX_FILE_BYTES, MAX_ROWS };
