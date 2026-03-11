# telepty

**Description:**
Help the user interact with the `telepty` daemon, check their current session ID, list active sessions, and inject commands into remote or local PTY sessions.

**Trigger:**
When the user asks about their current session ID (e.g. "내 세션 ID가 뭐야?"), wants to check active sessions ("세션 목록 보여줘"), or wants to inject a prompt/command into a specific session ("dustcraw한테 메시지 보내줘").

**Instructions:**
1. **To check the current session ID:**
   - Execute `run_shell_command` with `echo $TELEPTY_SESSION_ID`.
   - If the value is empty, inform the user that the current shell is *not* running inside a telepty spawned session (it is a normal native terminal).
   - If it has a value, output it clearly: "현재 계신 터미널의 telepty 세션 ID는 `[ID]` 입니다."
2. **To list all sessions:**
   - Run `telepty list`.
3. **To inject a command into another session:**
   - For a single session: Run `telepty inject <target_session_id> "<message or command>"`.
   - For broadcasting to ALL active sessions: Run `telepty broadcast "<message or command>"`.
   - For multicasting to multiple specific sessions: Run `telepty multicast <id1>,<id2> "<message or command>"`.
