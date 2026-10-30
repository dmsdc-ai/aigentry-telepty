# Preparing a staged strict-principal transition

Strict endpoints retain authenticated registration and reject shared-token/JWT
fallback. Preparation does not change the running daemon. REPORT ownership stays
at the original target; text-handoff consent does not delegate reporting. Foreign
principal trust remains at its current node-scoped boundary.

## 1. Check explicit proposed public configuration

Create a separate inventory describing each declared client's required grants:

```json
{
  "schema": "telepty.strict-client-inventory/v1",
  "audience": "the-proposed-trust-audience",
  "clients": [{
    "id": "wrapper-example",
    "authentication": "principal-v1",
    "key_id": "configured-public-key-id",
    "principal_id": "configured-principal-id",
    "requirements": [
      {"action": "session.register", "target": "exact-session"},
      {"action": "session.owner", "target": "exact-session"}
    ]
  }]
}
```

Use `authentication: "legacy"` without `key_id`/`principal_id` for a declared
legacy client. Such a client always blocks this static grant check. Requirements
are declarations, not proof that the client implements signing or that every
writer was inventoried. Include the actions actually needed by each client;
matching grants do not establish route support, runtime ownership or the operator
role needed to register a new wrapped session.

Run the offline inspection on explicit files:

```sh
node scripts/principal-preflight.js --trust /absolute/proposed-public-trust.json --inventory /absolute/client-inventory.json
```

The existing Linux authority-file adapter checks ownership, write permissions,
links, ancestors, bounds and stable reads. Inputs must be local regular files;
unsafe paths are refused, never repaired. Inventory bounds are 64 KiB, 128 clients
and 128 requirements per client, additionally subject to the existing strict JSON
parser's node/depth bounds. Trust uses its existing schema and limits. macOS and
Windows are refused until separate native authority adapters exist. Platform
simulation tests verify refusal, not native security acceptance.

Exit zero means only that all **declared** requirements match the public trust
snapshot. Exit one means a well-formed inventory contains a legacy client,
missing key, mismatched principal or missing declared grant. Exit two means input
or arguments are invalid/unsafe. Every report, including errors, says activation
is not permitted and authenticated registration, complete inventory and runtime
authorization are unverified. Snapshots of separate input files are not an atomic
configuration transaction. No output permits cutover.

The script reads no private signer, session registry or environment-selected default
configuration. It performs no HTTP/WS request, enrollment, rewrite, chmod, install,
service action or authentication-mode switch. Reports contain caller-selected
client labels and fixed reason codes, not keys, signatures, tokens or input paths.

## 2. Prove authenticated registration separately

An existing configured client can inspect exact composer evidence with the
[signed readiness CLI](principal-readiness.md). A signed read-only HTTP response
is still not proof of registration; it does not replace this stage's acceptance.

Use disposable fixture daemons and synthetic keys for compatibility acceptance.
Verify an exact signed registration, persisted principal/epoch, owner handshake,
stale/wrong key refusal, restart challenge and no shared-token fallback. Existing
principal HTTP/owner fixtures exercise these paths; they are not evidence that a
real fleet client has been enrolled. Legacy and strict preparations use separate
endpoints, never a mixed fallback path. Preserve original target REPORT authority
and foreign principal refusal through these tests.

## 3. Obtain operational evidence and authorization

Inventory every actual writer, including external Node/Rust clients. Gather native
credential and client acceptance on each supported OS, plus backup/rollback and
writer-quiescence evidence for any storage conversion. A label, idle lease or PID
does not prove that boundary. Strict default/client migration is a separately
authorized operational step; this tool cannot authorize or execute it.
