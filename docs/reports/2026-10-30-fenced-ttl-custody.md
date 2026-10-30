# Fenced write TTL preserves unknown custody

Baseline: dab29522a5b1d9b8678d272a53c98fc9a5f5f4fb, primary isolated
checkout telepty-issues-128-135, branch fix/issues-128-135. No other active agent
work or uncommitted changes existed at intake. The last cached issue inventory
contains 55 rows: 23 local implementations, 29 partial and three remaining.
No external issue refresh or transmission was performed in this pass.

## Reproduction and repair

Independent review reproduced a local custody defect relevant to #133 and the
delivery-uncertainty boundaries of #102. A message dequeued near its TTL receives
a durable non-retryable attempt fence. If the process is interrupted, a restart
after TTL but before the in-flight recovery timeout leaves it in flight.
`expireStale()` previously changed that unresolved attempt to `expired`; normal
compaction then removed payload and fence, permitting an empty custody snapshot.
The review reproduced this with the default 24-hour TTL and 30-second timeout.

TTL now skips a current `non_retryable_attempt` fence. A positive ACK may still
settle it; otherwise normal timeout recovery quarantines the exact original
payload with outcome unknown and automatic retry disabled. No new authority,
takeover policy or platform adapter is introduced. Untouched pending and legacy
unfenced in-flight TTL behavior remains unchanged.

Three regressions were added to the already registered
`test/pending-custody-handoff.test.js`: preservation with compaction thresholds
one and 100, restart and eventual unknown quarantine, plus an ordinary TTL
control. Before the source fix, both fenced regressions failed (`1 !== 0` for
the expiration count) and the control passed. After the fix, the custody,
settlement and takeover composition passed 55/55. Independent custody/settlement
verification passed 30/30 and a separate default-config fixture accepted a valid
ACK arriving after TTL but before recovery timeout. No Important/Critical
findings remain in that bounded review.

Logs: `/tmp/telepty-fenced-ttl-red.log`,
`/tmp/telepty-fenced-ttl-targeted.log`, and
`/tmp/telepty-independent-ttl-custody-review.log`. Restricted fixture invocations
returned opaque file-level failures; private fixture execution with the needed
permissions produced the stated assertion/pass results. No approval was denied.

## Remaining boundaries

Final integrated `npm test`: **2,518 total / 2,515 passed / zero failed / three
skipped**, 64.4 seconds; `/tmp/telepty-fenced-ttl-full.log`. The three skips are
the default-excluded long TCP test and the two native Windows tests; the earlier
explicit TCP result below is separate, not added to the full-suite count.
TypeScript noEmit, modified JavaScript syntax, fixture-diff guard and whitespace
checks passed. No clean dependency install or native acceptance is claimed.

The [32-row decision and acceptance plan](2026-10-30-residual-decision-priorities.md)
continues to apply; this fix does not close any entire partial issue. Tracked
REPORT ownership transfer, historical/ambiguous resend, strict-client migration,
foreign principal/reference trust and independent protected-action authority
still need their stated contracts. Native Windows/macOS, actual provider and
external writer compatibility remain unverified by this Linux source repair.

The previous requested explicit long TCP #732 run passed on baseline dab2952:
one selected test passed, zero failed, one unrelated name-filter exclusion,
91.3 seconds; `/tmp/telepty-tcp-stall-latest.log`. This proves fixture heartbeat
reaping, not the historical Mac incident's cause. The two native Windows tests
were not run. Operating services, installations, credentials, security/network
settings, live mailboxes and remote repositories were untouched.
