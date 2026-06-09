'use strict';

// #47 P4 — delivery provenance wrapper.
//
// Component B in the spec (docs/specs/2026-06-09-inject-audit-provenance.md §6; ADR §3/§4).
// Pure Node only (§17 무의존 — `crypto`, no external deps), no I/O, no daemon state, so the
// trust decision is unit-testable in isolation.
//
//   - mintSessionNonce()                  — per-session random nonce (the shared secret).
//   - resolveOrigin(ctx)                  — 'trusted-local' | 'untrusted-remote'.
//   - wrapDelivery(payload, {sid,origin,nonce})  — banner + fence around byte-exact payload.
//   - applyProvenance(payload, opts)      — capability gate: wrap iff capable && nonce, else RAW.
//
// TRUST MODEL (spec §6, ADR §3): this is a nonce-gated, tamper-EVIDENT in-band banner, NOT a
// signature. Strength = secrecy of the nonce; a body-typed banner without the session nonce is
// non-authoritative. The authoritative path stays OUT-OF-BAND (token-gated GET /api/injects).
//
// §1 경량 WATCHED LINE (ADR §4 A4): the banner is a single nonce STRING-MATCH only. No HMAC, no
// PKI, no signed envelope an LLM "verifies" — an LLM cannot verify crypto over its own input, so
// that would be security theater. If this grows toward a crypto protocol, that is the 위헌 line —
// stop.

const crypto = require('crypto');

const PROV_VERSION = 1;
// U+27E6 / U+27E7 — rare in normal prompts, visually distinct, single-token-ish across tokenizers.
const FENCE_OPEN = '⟦';  // ⟦
const FENCE_CLOSE = '⟧'; // ⟧

// Per-session random nonce. base64url so it survives intact through any plain-text channel and
// carries no fence/whitespace chars. 18 bytes → 24 url-safe chars (~144 bits).
function mintSessionNonce() {
  return crypto.randomBytes(18).toString('base64url');
}

// Map a delivery context to a coarse origin label. Explicit label wins; a `remote` signal maps
// to untrusted-remote; everything else (and any unknown label) is trusted-local.
function resolveOrigin(ctx = {}) {
  if (ctx.origin === 'trusted-local' || ctx.origin === 'untrusted-remote') return ctx.origin;
  if (ctx.remote === true) return 'untrusted-remote';
  return 'trusted-local';
}

// Render the banner `from=` field, honest about confidence: the verified sid verbatim when the
// daemon verified it, otherwise `claimed:<x>?` (trailing ? = unverified), or `claimed:?` if blank.
function formatSender({ verified, claimed } = {}) {
  if (verified) return String(verified);
  if (claimed) return `claimed:${claimed}?`;
  return 'claimed:?';
}

// Wrap a payload in the nonce-gated provenance banner (spec §6 format):
//   ⟦telepty:provenance v=1 from=<sid> origin=<...> nonce=<N>⟧
//   <payload, byte-for-byte>
//   ⟦telepty:end nonce=<N>⟧
// Requires a nonce — an un-nonced banner would be forgeable by anyone, defeating the gate.
function wrapDelivery(payload, opts = {}) {
  const { sid, origin, nonce } = opts;
  if (!nonce) throw new Error('wrapDelivery requires a nonce');
  const o = resolveOrigin({ origin });
  const from = sid != null ? sid : 'claimed:?';
  const body = typeof payload === 'string' ? payload : String(payload == null ? '' : payload);
  const header = `${FENCE_OPEN}telepty:provenance v=${PROV_VERSION} from=${from} origin=${o} nonce=${nonce}${FENCE_CLOSE}`;
  const footer = `${FENCE_OPEN}telepty:end nonce=${nonce}${FENCE_CLOSE}`;
  return `${header}\n${body}\n${footer}`;
}

// Capability gate for the delivery hot path (pure). Sessions that are NOT provenance-capable
// (the default) — or that have no minted nonce — receive the RAW payload byte-for-byte, so no
// existing session's delivered bytes change (regression guard, spec §6 rollout). Returns
// { payload, wrapped }.
function applyProvenance(payload, opts = {}) {
  const { capable, nonce, verified, claimed, origin } = opts;
  if (!capable || !nonce) return { payload, wrapped: false };
  const sid = formatSender({ verified, claimed });
  return { payload: wrapDelivery(payload, { sid, origin, nonce }), wrapped: true };
}

module.exports = {
  PROV_VERSION,
  mintSessionNonce,
  resolveOrigin,
  formatSender,
  wrapDelivery,
  applyProvenance
};
