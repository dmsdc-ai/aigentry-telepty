# telepty-test

Run the telepty automated test suite and report results.

## Instructions

1. Run the full test suite:
```bash
cd /Users/duckyoungkim/projects/aigentry-telepty && npm test
```

2. Parse the output and report:
   - Total tests, passed, failed
   - If any failures: show the failing test name and error message
   - If all pass: confirm with count

3. If tests fail, investigate:
   - Read the failing test in `test/daemon.test.js`
   - Check if daemon.js has related issues
   - Suggest or apply fixes
   - Re-run tests to confirm

## Arguments
- No arguments: run all tests
- `$ARGUMENTS`: if provided, use as a grep filter to run specific tests (e.g., "wrap", "register", "inject")
