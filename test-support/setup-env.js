// Test-env hygiene (#555): strip ambient TELEPTY_SESSION_ID before any test runs.
//
// `telepty inject` auto-stamps `from = TELEPTY_SESSION_ID` when `--from` is omitted
// (cli.js). That convenience is intentional for real sessions, but when the suite is
// run from a telepty session shell the test process inherits a real session id and
// leaks it into spawned cli.js subprocesses (the harness builds spawn env from
// `...process.env`), producing local-only reds that are CLEAN in CI where the var is
// unset. Loaded via `node --require` so it runs at startup in every test process,
// the deletion keeps the suite deterministic regardless of the ambient environment.
// Tests that need a session id still set it explicitly via their spawn env override.
delete process.env.TELEPTY_SESSION_ID;

// #672 tailnet auto-bind: the suite must be deterministic regardless of whether the host
// running it is on a Tailscale tailnet. Default the opt-out so spawned daemons bind
// loopback (the #50 policy the integration tests assert) instead of the host's live
// tailnet IP; the spawn harness builds child env from `...process.env`, so this
// propagates to spawned daemons. The tailnet path itself is covered by the pure decision
// fns (test/tailnet-autobind.test.js), not a live bind. A test can override by setting
// TELEPTY_NO_TAILNET_AUTO explicitly in its spawn env.
if (process.env.TELEPTY_NO_TAILNET_AUTO == null) process.env.TELEPTY_NO_TAILNET_AUTO = '1';
