# telepty Session Communication / 세션 통신

AI CLI sessions use `telepty` to communicate with other sessions.

## Environment Detection / 환경 감지

```bash
# Check if telepty is available
echo "$TELEPTY_AVAILABLE"    # "true" if telepty is installed and daemon running

# Get current session ID
echo "$TELEPTY_SESSION_ID"   # e.g., "aigentry-brain-claude"
```

If `$TELEPTY_AVAILABLE` is not set, telepty commands are unavailable.

## Commands / 명령어

| English action | 한국어 동작 | Command |
|----------------|------------|---------|
| List sessions | 세션 목록 보기 | `telepty list` |
| Send to session | 세션에 메시지 보내기 | `telepty inject <session> 'message'` |
| Send with return address | 발신자 포함 전송 | `telepty inject --from $TELEPTY_SESSION_ID <session> 'message'` |
| Send without enter | 엔터 없이 전송 | `telepty inject --no-enter <session> 'message'` |
| Broadcast to all | 전체 브로드캐스트 | `telepty broadcast 'message'` |
| Multicast to group | 그룹 멀티캐스트 | `telepty multicast <id1,id2> 'message'` |
| Reply to last sender | 마지막 발신자에게 답장 | `telepty reply 'message'` |
| Check session status | 세션 상태 확인 | `telepty list` (check connected/stale) |
| Read session screen | 세션 화면 읽기 | `curl -s http://127.0.0.1:3848/api/sessions/<id>/screen -H "x-telepty-token: $TOKEN"` |
| Kill session | 세션 종료 | `telepty delete <session>` |
| Clean stale sessions | 비활성 세션 정리 | `telepty clean` |
| Rename session | 세션 이름 변경 | `telepty rename <old> <new>` |
| Listen to event bus | 이벤트 버스 수신 | `telepty listen` |
| Attach to session | 세션에 접속 | `telepty attach <session>` |

## Natural Language → Command / 자연어 → 명령어

| English request | 한국어 요청 | Command |
|----------------|------------|---------|
| `list sessions` | `세션 목록 보여줘` | `telepty list` |
| `send to brain` | `brain에 메시지 보내줘` | `telepty inject aigentry-brain-claude 'msg'` |
| `broadcast message` | `전체에 메시지 보내줘` | `telepty broadcast 'msg'` |
| `reply to sender` | `답장해줘` | `telepty reply 'msg'` |
| `kill session` | `세션 종료해줘` | `telepty delete <session>` |
| `clean stale` | `비활성 정리해줘` | `telepty clean` |
| `check status` | `상태 확인해줘` | `telepty list` |
| `rename session` | `세션 이름 바꿔줘` | `telepty rename <old> <new>` |
| `read screen` | `화면 읽어줘` | REST API `/api/sessions/<id>/screen` |

## Cross-Machine Sessions / 크로스 머신 세션

When the same session ID exists on multiple hosts, use `session_id@host`:

```bash
telepty inject brain-claude@macbook 'message'
```

## Rules / 규칙

1. **Return address**: Always include `--from $TELEPTY_SESSION_ID` when expecting a reply.
2. **Submit method**: Never rely on PTY `\r` directly. Use `telepty inject` which handles submit automatically.
3. **Env detection**: Check `$TELEPTY_AVAILABLE` before using telepty commands.
4. **Session ID format**: Use `<project>-<cli>` pattern (e.g., `aigentry-brain-claude`).

## Reporting / 보고

On task completion, report to orchestrator:

```bash
telepty inject --from $TELEPTY_SESSION_ID aigentry-orchestrator-claude 'REPORT: <summary>'
```
