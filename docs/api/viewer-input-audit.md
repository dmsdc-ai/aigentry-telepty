# Legacy viewer input validation and dispatch audit

Legacy authenticated viewer input now requires string data of at most64KiB UTF-8
before policy, audit or writer invocation. Nonstring data receives
INVALID_INPUT_FRAME with known zero bytes; oversized data receives
INPUT_FRAME_TOO_LARGE before any write. Empty strings remain valid. This prevents
classifying/auditing an empty string while a later bridge coerces an object into
different terminal input. Valid boundary-size Unicode data is preserved exactly.
This is an accepted-data bound; it does not replace the legacy WebSocket parser's
separate frame limits.

The existing peer-lane gate and verified handshake sender fields are retained.
A blocked attempt still produces its existing blocked ws-viewer audit row.
An allowed attempt now produces an admission row with source ws-viewer-admission
and delivery_result:authorized. This uses the same optional buffered audit writer;
it is not a new durable write-ahead transaction or evidence of physical delivery.

The corresponding source:ws-viewer outcome, correlated by inject_id, is recorded
only after the wrapped owner WebSocket send callback succeeds, or a native PTY
write method returns. delivery_result:forwarded describes transport dispatch,
not child write, agent consumption or reply. Synchronous writer/invalidation
failure or asynchronous send error produces outcome_unknown. Duplicate/late
callbacks cannot add a second success after failure. A completion audit exception
is contained, and the viewer receives the same named unknown outcome rather than
a false zero-write failure.

The unknown refusal is type:input_refused, code:INPUT_WRITE_OUTCOME_UNKNOWN,
bytes_written:null, retryable:false and consumption:unknown. Both attach CLI paths display fixed refusal/uncertainty text on stderr, including
the size limit; server error text, codes and payload are never printed as terminal
markup. This change adds no automatic retry, raw-input idempotency ledger or
success ACK protocol. A crash
before callback leaves an admission rather than a falsely forwarded outcome.
Consumers must distinguish the two sources and correlate their shared inject_id;
they are stages, not two delivered inputs. Existing preview/redaction settings
remain authoritative.

This does not open a new strict raw-control ingress. Protected external-approval
targets and unsupported SSH raw viewing retain their existing refusals. A signed
prompt inject approval authorizes operation:inject; it does not authorize arbitrary
control bytes or resize. Typed interaction still requires measured current UI and
final-write fences, and refuses trust/authentication/unknown/running surfaces.
General new raw control needs an explicit byte/control contract and compatible
UI/approval authority at that boundary. It must not bypass these checks by calling
the legacy viewer writer directly.
