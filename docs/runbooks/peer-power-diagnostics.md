# Interpreting peer power in Telepty diagnostics

Run a bounded read-only observation against a peer whose address and machine ID were already established:

```sh
telepty diagnose 'orchestrator@mac-peer' --machine-id '<expected-machine-id>' --json --tcp
```

Check `layers.host_power` separately from the session result and process status.
The MCP diagnostic tool returns the same layer for its already configured daemon.

- `running_at_observation`: the existing authenticated request path received a daemon metadata response with the expected machine ID at `observed_at`. It does not certify the machine is still running, that the lid is open, or that a particular session or task is ready. In particular, the power observation can be positive when the later session lookup fails.
- `unknown`: no matching evidence. A timeout, TCP refusal, missing peer in discovery, credential refusal, daemon restart, and a session not responding are not proof of power-off. The separate layers retain diagnostic evidence; do not turn any of them into a power-off flag. If there was only an unpinned endpoint reply, establish the intended peer's identity first.

This diagnostic does not measure physical power-off. A later power observer must treat a verified OS report of a shutdown transition as a last observed event, not as ongoing proof of physical power-off. Sleeping, a dead battery, power loss, and network loss may all cut the report path. Persistent or present power-off assertions need an independent observer that directly measures laptop power state (AC outlet state is insufficient for a battery-powered laptop); retain source, freshness and peer binding, and prefer unknown if the observer is absent. No extra access, automatic wake, or repair is performed.
