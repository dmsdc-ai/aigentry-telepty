# Strict WS and CLI continuation

Baseline: local 5f972ed; preserve all prior issue fixes and PR125 ancestor. Existing user authorization covers isolated code repair and synthetic local fixtures, with no install/service/security-setting/remote mutations.

1. Check strict HTTP ownership, legacy owner protocol and bus side effects before selecting adapters.
2. Add checked Linux signer client: exact origin, private key and config authority checks, fresh bounded challenge, no legacy credentials/redirect/retry. Add explicit read-only observer CLI with exact session/epoch and JSON output.
3. Add owner-only strict WS through existing owner lifecycle, exact session.owner grant, owning principal/current epoch plus bearer, protected transport and bounded connection instance/sequence/expiry. Explicit signer allow uses this path; preserve legacy mode.
4. Keep input and bus ingress closed until their actual effects have action-specific authority and delivery semantics. Do not call legacy busAutoRoute from a generic signed connection: it trusts claimed sender and resolves aliases.
5. Run synthetic-key target regressions, full Linux suite and type checks. Independently review authority boundaries, integrate only verified changes, report remaining adapters and native acceptance conditions.

An input WS adapter must preserve current inject gates/audit/idempotency and distinguish acceptance, owner dispatch, child write and consumption. A strict bus needs trusted event provenance and per-session projections before exposing daemon events; an app-only pubsub is not compatible completion.
