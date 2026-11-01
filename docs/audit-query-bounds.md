# Bounded audit API queries (#106)

`GET /api/injects` now delegates file reading, JSON parsing, filtering and response serialization to a fixed worker module. The daemon supplies its own active audit path; query parameters cannot select a file or worker. The synchronous `readInjectLog` library export is unchanged.

The reader walks backward in 64 KiB chunks and reconstructs whole UTF-8 lines before decoding. It retains only the selected page, with at most 1,000 rows, and reads one additional matching row to establish `next_cursor`. Filters and newest-first scalar cursor semantics match the legacy reader. Malformed JSON and falsy parsed rows retain the legacy skip behavior. A valid final JSON record without a newline is included; an incomplete malformed tail is skipped.

The fixed budgets are:

| Resource | Bound |
|---|---:|
| Active worker threads | 2 |
| Query wall deadline | 10 seconds |
| Active file snapshot | 64 MiB (covers the default 50 MiB rotation size) |
| Read chunk | 64 KiB |
| One row | 256 KiB |
| Serialized page response | 2 MiB |
| Worker old/young JS heaps | 32/4 MiB |
| Worker stack | 2 MiB |

Encountering an oversized row or exceeding a file/response budget fails the whole query with HTTP 503 `AUDIT_QUERY_BUDGET_EXCEEDED`; no partial/empty page is substituted. Unreadable, nonregular or changed files return typed unavailability. Only an actually absent active file returns an empty page, as before. A third concurrent query returns HTTP 429 `AUDIT_QUERY_BUSY`. Worker failures and deadlines return typed 503 results without raw filesystem paths, payloads or exception text.

A timed-out thread keeps its capacity slot until termination/exit is confirmed, so repeated deadlines cannot create an unbounded number of native threads. Workers are unreferenced, unmanaged file descriptors are tracked, and shutdown closes the reader before awaiting the existing audit-writer flush. A potentially uninterruptible filesystem operation cannot delay that writer flush indefinitely; worker termination is requested explicitly and no further reads are admitted after close.

The response is serialized inside the worker; the API sends that bounded string without parsing or filtering it on the request thread. CLI `injects --json`, including tail mode, exits nonzero and emits a structured failure for query errors. It does not display an empty history or a human startup banner on JSON stdout.

Each query reads the active file descriptor at its initial size. Later appends are outside that snapshot; rotation and concurrent appends retain the existing limitations of scalar pagination between independent requests. This change does not introduce a stable historical cursor across rotations or scan rotated files.

Validation includes a small legacy oracle for filters/deep/fractional cursors, complete/partial lines and split UTF-8, a real 50 MiB query with a single retained row, explicit row/response budgets, controlled timeout/capacity/error/shutdown cases, and real HTTP/CLI error paths. A test-owned held worker proves the health endpoint continues answering while query work is pending. All files, workers and daemons used by tests are isolated fixtures.

This bounds a known main-thread hot path. The reported macOS intermittent stall has not been reproduced, and this is not a claim that its cause has been established or eliminated.
