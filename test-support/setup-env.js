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
