'use strict';
const crypto = require('node:crypto');
const { verifierFor } = require('../session-store/session-credentials');
const { mintSessionNonce } = require('../audit/provenance');
const { parseMailboxLease } = require('../mailbox/poll-session');
const { verifiedRequestPrincipal, storedOwningPrincipal } = require('./http');
const { bodyDigest } = require('./encoding');
const { MAX_AUTHORITY_EVENTS, normalizeAuthorityAudit } = require('./authority-audit');
function registerMailboxTakeoverRoute(app, { context, getMailbox, broadcastSessionEvent = () => { }, now = Date.now }) {
    app.post('/api/sessions/:id/takeover', (req, res) => {
        const id = req.params.id;
        const denied = (status, code) => res.status(status).json({ success: false, code });
        // This proof is separate from legacy machine/session credentials and is bound to this
        // exact operation and target by the private middleware context, not a caller-selected sub.
        const principal = verifiedRequestPrincipal(req, { action: 'session.takeover', target: id });
        if (!principal)
            return denied(403, 'TAKEOVER_PRINCIPAL_REQUIRED');
        const session = Object.prototype.hasOwnProperty.call(context.sessions, id) && context.sessions[id];
        const owner = storedOwningPrincipal(session?.owningPrincipal);
        if (!session)
            return denied(404, 'SESSION_NOT_FOUND');
        if (!owner || owner.id !== principal.id || owner.audience !== principal.audience)
            return denied(403, 'TAKEOVER_OWNER_REQUIRED');
        if (session.isClosing)
            return denied(409, 'SESSION_CLOSING');
        if (session.type !== 'mailbox')
            return denied(409, 'TAKEOVER_TRANSPORT_UNSUPPORTED');
        if (session.ownerWs || session.ptyProcess || session.ownerPid || session.ptyPid)
            return denied(409, 'TAKEOVER_PROCESS_CUSTODY_UNAVAILABLE');
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some(key => !['expected_epoch', 'lease_seconds'].includes(key)))
            return denied(400, 'TAKEOVER_INVALID_REQUEST');
        if (typeof body.expected_epoch !== 'string' || body.expected_epoch !== session.sessionEpoch)
            return denied(409, 'TAKEOVER_EPOCH_CHANGED');
        const at = now();
        if (!Number.isSafeInteger(at) || !Number.isFinite(session.leaseExpiresAt) || session.leaseExpiresAt < 0)
            return denied(409, 'TAKEOVER_LEASE_UNKNOWN');
        if (session.leaseExpiresAt > at)
            return denied(409, 'TAKEOVER_LEASE_ACTIVE');
        const lease = parseMailboxLease(body.lease_seconds);
        if (lease.error)
            return denied(400, 'INVALID_LEASE');
        const generation = session.credentialGeneration;
        if (!/^[A-Za-z0-9_-]{22}$/.test(session.sessionEpoch || '') || !/^[a-f0-9]{64}$/.test(session.credentialVerifier || '')
            || !Number.isSafeInteger(generation) || generation < 1 || generation >= Number.MAX_SAFE_INTEGER)
            return denied(409, 'TAKEOVER_CREDENTIAL_STATE_INVALID');
        if (session.authorityAuditInvalid === true)
            return denied(409, 'TAKEOVER_AUDIT_INVALID');
        const history = normalizeAuthorityAudit(session.authorityAudit);
        if (history === null)
            return denied(409, 'TAKEOVER_AUDIT_INVALID');
        // Poll reads expose bytes without recording a physical attempt. Lease expiry
        // cannot prove those bytes were unseen or that the old consumer stopped.
        try {
            return getMailbox().withCustodySnapshot(id, pending => {
                if (context.sessions[id] !== session || session.isClosing || session.sessionEpoch !== body.expected_epoch
                    || session.credentialGeneration !== generation)
                    return denied(409, 'TAKEOVER_EPOCH_CHANGED');
                const lockedOwner = storedOwningPrincipal(session.owningPrincipal);
                if (!lockedOwner || lockedOwner.id !== principal.id || lockedOwner.audience !== principal.audience)
                    return denied(403, 'TAKEOVER_OWNER_REQUIRED');
                const at = now();
                if (!Number.isSafeInteger(at) || !Number.isFinite(session.leaseExpiresAt) || session.leaseExpiresAt > at)
                    return denied(409, 'TAKEOVER_LEASE_ACTIVE');
                if (session.ownerWs || session.ptyProcess || session.ownerPid || session.ptyPid)
                    return denied(409, 'TAKEOVER_PROCESS_CUSTODY_UNAVAILABLE');
                if (pending.length)
                    return denied(409, 'TAKEOVER_PENDING_UNPROVEN');
                const custodyDigest = bodyDigest([]);
                const epoch = crypto.randomBytes(16).toString('base64url');
                const bearer = `${epoch}.${crypto.randomBytes(32).toString('base64url')}`;
                const nonce = mintSessionNonce();
                const audit = { schema: 'telepty.mailbox-takeover/v1', actor: { id: principal.id, key_id: principal.keyId,
                        source: 'ed25519', audience: principal.audience }, at: new Date(at).toISOString(),
                    previous_epoch: session.sessionEpoch, next_epoch: epoch, previous_generation: generation, next_generation: generation + 1,
                    previous_owner_state: 'mailbox_lease_expired', previous_lease_expires_at: session.leaseExpiresAt, pending_count: pending.length,
                    custody_digest: custodyDigest };
                const previous = Object.getOwnPropertyDescriptors(session);
                Object.assign(session, { sessionEpoch: epoch, credentialVerifier: verifierFor(bearer), credentialGeneration: generation + 1,
                    provenanceNonce: nonce, sessionEpochProved: null, ownerToken: null, interactionOwnerGeneration: null,
                    leaseExpiresAt: at + lease.seconds * 1000, lastConnectedAt: audit.at, lastDisconnectedAt: null,
                    lastActivityAt: audit.at, stateReport: null, lastStateReportAt: null,
                    authorityAudit: [...(history || []), audit].slice(-MAX_AUTHORITY_EVENTS) });
                const saved = context.persistSessions();
                if (!saved?.ok && !saved?.committed) {
                    for (const key of Object.keys(session))
                        delete session[key];
                    Object.defineProperties(session, previous);
                    return denied(503, 'SESSION_STORE_WRITE_FAILED');
                }
                // Keep the credential index consistent with the visible generation even if directory sync
                // failed after rename. Such an uncertain commit discloses no bearer and claims no success.
                context.sessionCredentials.revoke(id);
                context.sessionCredentials.adopt(id, session);
                context.sidNonces.set(id, nonce);
                if (!saved.ok)
                    return denied(503, 'SESSION_STORE_WRITE_FAILED');
                try {
                    broadcastSessionEvent('session_takeover', id, session, { extra: { authority_audit: audit } });
                }
                catch { }
                return res.json({ success: true, session_id: id, type: 'mailbox', session_epoch: epoch,
                    credential_generation: generation + 1, session_token: bearer, session_nonce: nonce,
                    lease_expires_at: session.leaseExpiresAt, pending: pending.length, custody: 'preserved', audit });
            }, { durable: true });
        }
        catch {
            return denied(503, 'TAKEOVER_CUSTODY_UNAVAILABLE');
        }
    });
}
module.exports = { registerMailboxTakeoverRoute };
