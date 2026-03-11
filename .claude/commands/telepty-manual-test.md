# telepty-manual-test

Guided manual test of the telepty enable (inject) feature. Runs step-by-step verification.

## Instructions

Execute each step sequentially, verifying results before proceeding.

### Step 1: Ensure daemon is running
```bash
cd /Users/duckyoungkim/projects/aigentry-telepty
curl -s http://127.0.0.1:3848/api/sessions 2>/dev/null || node daemon.js &
sleep 1
```

### Step 2: Register a wrapped session via API
```bash
TOKEN=$(cat ~/.telepty/config.json 2>/dev/null | grep authToken | cut -d '"' -f 4)
curl -s -X POST http://127.0.0.1:3848/api/sessions/register \
  -H "Content-Type: application/json" \
  -H "x-telepty-token: $TOKEN" \
  -d '{"session_id": "manual-test-1", "command": "test", "cwd": "'"$(pwd)"'"}'
```
**Verify**: response has `type: "wrapped"` and status 201.

### Step 3: Check session listing
```bash
curl -s http://127.0.0.1:3848/api/sessions -H "x-telepty-token: $TOKEN" | python3 -m json.tool
```
**Verify**: `manual-test-1` appears with `type: "wrapped"`.

### Step 4: Test inject without owner (should fail)
```bash
curl -s -X POST http://127.0.0.1:3848/api/sessions/manual-test-1/inject \
  -H "Content-Type: application/json" \
  -H "x-telepty-token: $TOKEN" \
  -d '{"prompt": "hello"}'
```
**Verify**: returns 503 with "not connected" error.

### Step 5: Clean up test session
```bash
curl -s -X DELETE http://127.0.0.1:3848/api/sessions/manual-test-1 \
  -H "x-telepty-token: $TOKEN"
```
**Verify**: returns status "closing".

### Step 6: Verify session removed
```bash
curl -s http://127.0.0.1:3848/api/sessions -H "x-telepty-token: $TOKEN"
```
**Verify**: `manual-test-1` no longer in the list.

### Step 7: Run automated tests
```bash
npm test
```
**Verify**: all 25 tests pass.

### Report
Summarize all verification results in a table:

| Step | Check | Result |
|------|-------|--------|
| 2 | Register returns 201 + wrapped | ? |
| 3 | Session in list with type | ? |
| 4 | Inject without owner = 503 | ? |
| 5 | DELETE returns closing | ? |
| 6 | Session removed | ? |
| 7 | All tests pass | ? |

## Arguments
- `$ARGUMENTS`: ignored
