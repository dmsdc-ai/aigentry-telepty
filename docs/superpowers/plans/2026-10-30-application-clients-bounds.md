# Application publication, effect clients and bounded output

Baseline f3d10d0. Continue the existing local issue repairs with no installed/live
service, real credential, network/security setting or remote mutation.

1. Complement exact bus state/turn effects with separately granted owner-only
application publication and exact authorized read subscription. Keep data opaque
and explicitly untrusted inside a server-authored actor/SID/epoch/UUID envelope.
Never call trusted daemon fanout, raw bus routing or terminal writers from data.
Use protected transport and existing bounded/fenced read behavior.
2. Add app_publish through existing signed HTTP effect authority and durable
namespaced receipt semantics. Lost responses never cause automatic republish;
matched sockets are explicitly not an ACK. Preserve old trusted event/input APIs.
3. Reuse the real input client for bus CLI state/turn/app requests and own receipt
queries. Validate accepted receipts for consistency and canonical identities;
project only bounded result fields with unknown consumption/reply. Keep checked
private files, same-origin proofs and no token/startup/retry fallback.
4. Fix independently reproduced allow reconnect buffer defects: oversized single
callbacks and empty-entry metadata growth. Retain only bounded recent UTF16 text
and chunk count, preserve order/Unicode at clipping, and own copied storage so V8
substring views cannot pin an arbitrarily large backing string. Test actual GC.
5. Run isolated actual CLI/application tests, input/reader compatibility, independent
security and memory review, then full Linux suite/type/syntax checks. Reconcile all
55 issues and distinguish remaining raw/handoff authority contracts, source work,
native acceptance and explicitly forbidden remote publication.
