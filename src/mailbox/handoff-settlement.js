'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { bodyDigest, parseUnambiguousJSON } = require('../principal/encoding');
const { readAuthorityFile } = require('../principal/authority-file');
const proofs = new WeakMap(), used = new WeakSet();
const FILE = 'handoff-settlements.jsonl', MAX_RECORDS = 512, MAX_BYTES = 512 * 1024;
const fields = ['schema', 'session_id', 'session_epoch', 'origin_epoch', 'origin_owner_generation', 'intent_id', 'pending_digest', 'msg_id', 'message_digest', 'measurement', 'mailbox_state', 'consumption', 'reply', 'ack_at'];
function unavailable() {
    throw Object.assign(new Error('Handoff ACK settlement unavailable'), {
        code: 'HANDOFF_SETTLEMENT_UNAVAILABLE'
    });
}
const text = v => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 128 && !/[\x00-\x1f\x7f]/.test(v);
const epoch = v => typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function valid(row) {
    return row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === fields.length && Object.keys(row).every(key => fields.includes(key))
        && row.schema === 'telepty.pending-transport-ack/v1' && text(row.session_id) && epoch(row.session_epoch) && epoch(row.origin_epoch) && row.session_epoch !== row.origin_epoch
        && uuid(row.origin_owner_generation) && uuid(row.intent_id) && hash(row.pending_digest) && text(row.msg_id) && hash(row.message_digest)
        && row.measurement === 'bridge_child_write_invoked' && row.mailbox_state === 'acked' && row.consumption === 'unknown' && row.reply === 'unknown' && Number.isSafeInteger(row.ack_at) && row.ack_at >= 0;
}
function binding(sessionId, event, row) {
    return {
        schema: 'telepty.pending-transport-ack/v1', session_id: sessionId, session_epoch: event.next_epoch, origin_epoch: event.epoch,
        origin_owner_generation: event.owner_generation, intent_id: event.id, pending_digest: event.pending_digest, msg_id: row.id, message_digest: row.digest,
        measurement: 'bridge_child_write_invoked', mailbox_state: 'acked', consumption: 'unknown', reply: 'unknown'
    };
}
function same(row, expected) {
    return Object.keys(expected).every(key => row[key] === expected[key]);
}
function syncDir(dir) {
    if (process.platform === 'win32')
        return;
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
    try {
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}
// Authority-bearing proof storage: never "repair" permissions on an existing object.
function checkedDirectory(directory) {
    if (process.platform !== 'linux' || typeof process.getuid !== 'function' || !fs.constants.O_DIRECTORY || !fs.constants.O_NOFOLLOW
        || !path.isAbsolute(directory) || path.normalize(directory) !== directory)
        unavailable();
    const uid = process.getuid();
    let fd;
    try {
        fd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        const parts = directory.split('/').filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
            const next = fs.openSync(`/proc/self/fd/${fd}/${parts[i]}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            fs.closeSync(fd);
            fd = next;
            const stat = fs.fstatSync(fd), sticky = stat.uid === 0 && (stat.mode & 0o1777) === 0o1777;
            if (!stat.isDirectory() || ![0, uid].includes(stat.uid) || ((stat.mode & 0o022) && !sticky)
                || (i === parts.length - 1 && (stat.uid !== uid || (stat.mode & 0o077))))
                unavailable();
        }
        return fd;
    }
    catch {
        if (fd !== undefined)
            fs.closeSync(fd);
        unavailable();
    }
}
function readSettlements(directory, { sync = false } = {}) {
    let dir, fd;
    try {
        dir = checkedDirectory(directory);
        const file = `/proc/self/fd/${dir}/${FILE}`;
        let before;
        try {
            before = fs.lstatSync(file);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        }
        if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || (before.mode & 0o077) || before.size > MAX_BYTES)
            unavailable();
        const bytes = readAuthorityFile(path.join(directory, FILE), {
            maximum: MAX_BYTES, privateFile: true
        });
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid() || (opened.mode & 0o077) || opened.ino !== before.ino || opened.dev !== before.dev
            || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs)
            unavailable();
        const count = bytes.length;
        const source = bytes.subarray(0, count).toString('utf8');
        if (!Buffer.from(source).equals(bytes.subarray(0, count)) || (source && !source.endsWith('\n')))
            unavailable();
        const lines = source.split('\n').filter(Boolean);
        if (lines.length > MAX_RECORDS)
            unavailable();
        const rows = lines.map(line => parseUnambiguousJSON(line));
        if (rows.some(row => !valid(row)))
            unavailable();
        const seen = new Set();
        for (const row of rows) {
            const key = bodyDigest([row.session_id, row.session_epoch, row.intent_id, row.msg_id]);
            if (seen.has(key))
                unavailable();
            seen.add(key);
        }
        if (sync) {
            fs.fsyncSync(fd);
            fs.fsyncSync(dir);
            syncDir(path.dirname(directory));
        }
        return rows;
    }
    catch {
        unavailable();
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
        if (dir !== undefined)
            fs.closeSync(dir);
    }
}
function captureSettlement(result, session, message) {
    if (used.has(result))
        unavailable();
    const helper = require('../principal/pending-handoff'), event = helper.transferredRecord(session, message);
    if (!event || result?.success !== true || result.measurement !== 'bridge_child_write_invoked' || result.bytes_written !== null || !event.pending_write_invoked?.includes(message.msg_id))
        unavailable();
    const row = event.pending_records.find(row => row.id === message.msg_id && row.digest === bodyDigest(message));
    if (!row)
        unavailable();
    if (!helper.consumeVerifiedPendingWrite(result, session, message))
        unavailable();
    proofs.set(result, {
        binding: binding(session.id, event, row), digest: bodyDigest(message)
    });
    return result;
}
function hasProof(result) {
    return !!result && proofs.has(result);
}
function usedProof(result) {
    return !!result && used.has(result);
}
function commitSettlement(directory, sessionId, message, result) {
    const proof = proofs.get(result);
    if (!proof)
        return false;
    proofs.delete(result);
    used.add(result);
    if (proof.binding.session_id !== sessionId || proof.binding.msg_id !== message?.msg_id || proof.digest !== bodyDigest(message))
        unavailable();
    const rows = readSettlements(directory), prior = rows.find(row => row.session_id === sessionId && row.session_epoch === proof.binding.session_epoch && row.intent_id === proof.binding.intent_id && row.msg_id === message.msg_id);
    if (prior) {
        if (!same(prior, proof.binding))
            unavailable();
        return true;
    }
    if (rows.length >= MAX_RECORDS)
        unavailable();
    const next = {
        ...proof.binding, ack_at: Date.now()
    };
    if (!valid(next))
        unavailable();
    const bytes = rows.map(row => JSON.stringify(row) + '\n').join('') + JSON.stringify(next) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES)
        unavailable();
    const directoryFd = checkedDirectory(directory), file = `/proc/self/fd/${directoryFd}/${FILE}`, temporary = `/proc/self/fd/${directoryFd}/${FILE}.${crypto.randomBytes(16).toString('hex')}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, file);
        fs.fsyncSync(directoryFd);
        syncDir(path.dirname(directory));
        return true;
    }
    catch {
        unavailable();
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
        try {
            fs.unlinkSync(temporary);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        finally {
            fs.closeSync(directoryFd);
        }
    }
}
function confirmed(rows, sessionId, event, record) {
    return rows.some(row => same(row, binding(sessionId, event, record)));
}
module.exports = {
    captureSettlement, hasProof, usedProof, commitSettlement, readSettlements, confirmed, MAX_RECORDS, MAX_BYTES, FILE
};
