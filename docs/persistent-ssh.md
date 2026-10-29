# Optional persistent SSH sessions (#11; safe portions of #12)

```sh
telepty ssh user@host --id remote-code --persistent \
  --remote-command codex --cwd '~/projects/example' --resume <conversation-id> \
  --server-alive-interval 15 --server-alive-count-max 3 --connect-timeout 10
```

OpenSSH is selected from PATH and launched as an argv array with `-tt`, bounded keepalive/connect options, and `BatchMode=yes`. This requires existing key/agent authentication. Telepty does not accept passwords, automate host-key acceptance, disable host-key verification, alter known_hosts, configure networking, install SSH/autossh, or upgrade a remote provider. Existing SSH config and normal host-key verification apply. This feature uses OpenSSH semantics and a POSIX remote shell; other remote shell implementations remain unsupported.

`--remote-command` names one executable. Pass its arguments after `--`; Telepty quotes every remote argument for the POSIX shell, and quotes the cwd separately. A leading `~/` is expanded using the remote `$HOME`; other relative paths remain relative. `--resume <conversation-id>` constructs explicit Codex `resume <id>` or Claude `--resume <id>` argv. Missing ids, `latest`/interactive picker selection, and other provider resume contracts are refused. No picker is selected automatically. The remote command runs again after reconnect; only the remote provider can establish conversation/session continuity.

Without `--persistent`, a child exit closes the session as usual. With it, every SSH child exit (including exit 0) reconnects until the wrapper is killed/deleted. Backoff defaults to 1 second, doubles to a 30-second ceiling, and resets after the existing 30-second survival window. `--backoff-ms` accepts 10..30000 and `--backoff-max-ms` 10..60000; the maximum must be at least the initial delay. Keepalive interval is 1..300 seconds, count 1..10, connection timeout 1..120 seconds, and optional `--port` 1..65535. Ordinary `allow --auto-restart` retains its existing three-crash limit.

The persistent process uses the existing allow owner claim, child-generation callback fences, and kill/delete lifecycle. Its stable wrapper PID is the kill target; a replaceable or exited SSH child PID must not become the authority for cancellation. Local keyboard input while reconnecting is refused and discarded with a diagnostic, rather than replayed into another child. Keyboard input is an operator action; Telepty never invents keystrokes.

# Readiness and input admission

`command` remains `ssh`, the local transport. `sshRemote` metadata separately reports the operator-declared target, remote cwd, URI, recognized agent, persistent/resume intent and `version_status: unsupported`. These are declarations, not authenticated remote principal or verified remote cwd/version claims. The current child generation and phase appear in `ssh`; readiness uses the existing qualified `handshake` block and `telepty wait-ready` command.

Automated input is refused before a known Codex/Claude/Gemini composer is observed, during recognized authentication/host-key/trust/update/resume UI, and through reconnect. A generic remote shell has no qualified agent readiness and therefore reports unsupported; its terminal remains manually usable. No CONNECTED flag, elapsed timeout, generic `$` prompt or owner-alive fallback grants automated SSH input.

SSH writes use an owner- and child-generation-bound request/receipt. Legacy raw inject/viewer input cannot bypass it. A body may be written once when the current composer is ready; its separate Enter is one-use, has a five-second budget and remains bound to that child. A dialog, disconnect, new child or expired permit denies Enter. A composer repaint while unsent text is present does not admit a second prompt. Direct force/typed/terminal fallback paths cannot approve an authentication or bootstrap dialog.

There is no automatic prompt buffering/replay across SSH reconnects in this version. A not-ready refusal says that nothing was queued. If text was written before a connection loss but Enter is not confirmed, the HTTP response exposes `text_written`, `text_bytes_written` and `retry_safe: false`; the caller must inspect/reconcile before retrying. A write receipt means bytes were handed to the current local SSH PTY, not that a remote agent consumed, answered or completed them. Existing protected-session approval rules remain in effect; protected SSH transports require explicit support in that approval path and otherwise fail closed.

# Validation and remaining scope

Portable builder/controller tests check shell quoting, options, token removal, UI blockers, generation fences, one-use submit and receipt bounds. The Linux integration fixture runs the actual wrapper plus a private ephemeral daemon with a test-owned fake `ssh` executable. It exercises more than three disconnects, qualified prompt startup, blocked input, a disconnect between body/Enter, and cancellation by both kill and delete. No real SSH connection, host key, user credential or installed service is used.

Native OpenSSH reconnect across real network failures, macOS/Windows terminals, remote agent versions and remote POSIX-shell variations still require native acceptance. #12's automatic update dismissal, latest-session picker, provider upgrade/model checks, terminal workspace ownership and verified remote cwd/version are not implemented. The new CLI is the narrower `ssh` transport; it is not a claim that the full `ai-session` proposal is complete.
