# AGENTS.md — aigentry-telepty

## Overview

PTY Multiplexer & Session Orchestrator — aigentry 에코시스템의 **통신 인프라**.
npm: `@dmsdc-ai/aigentry-telepty` | 멀티 AI 세션을 생성·연결·제어하는 PTY 멀티플렉서.

## Architecture

```
CLI (cli.js) ──→ HTTP/WS ──→ Daemon (daemon.js:3848)
                                ├── Session WS (/api/sessions/:id)
                                ├── Event Bus WS (/api/bus)
                                └── REST API (/api/sessions/*)
```

| 파일 | 역할 |
|------|------|
| `cli.js` | CLI 명령 + allow-bridge (PTY 래핑) |
| `daemon.js` | HTTP/WS 서버, 세션 상태, inject 전달 |
| `tui.js` | blessed 기반 TUI 대시보드 |
| `session-routing.js` | 세션 ID 해석, alias 매칭, 호스트 그룹핑 |
| `daemon-control.js` | 싱글톤 daemon PID 관리 |
| `auth.js` | UUID 토큰 기반 인증 |
| `interactive-terminal.js` | raw mode stdin/stdout 관리 |
| `skill-installer.js` | CLI별 스킬 설치 (Claude/Codex/Gemini) |

## Inject 전달 경로 (wrapped session)

1. **Primary**: `kitty @ send-text` (터미널 직접 전달, allow-bridge 우회)
2. **Fallback**: WS → allow-bridge → `child.write()` (PTY)
3. **Submit**: `osascript` Return 키 → kitty fallback → WS `\r`

busy 세션: CR은 큐에 대기 중인 텍스트와 함께 큐잉 후 올바른 순서로 flush.

## Commands

```bash
npm test                    # 43 tests (node:test)
telepty daemon              # daemon 시작 (포트 3848)
telepty allow --id <name> claude  # 세션 래핑
telepty tui                 # TUI 대시보드
telepty list                # 세션 목록
telepty inject <id> "msg"   # 메시지 주입
telepty broadcast "msg"     # 전체 브로드캐스트
telepty session start --launch  # kitty 탭으로 다중 세션 시작
```

## Key Rules

- inject 후 submit은 항상 `osascript`로 통일 (`--no-enter` + osascript keystroke)
- inject 시 발신자 session ID (`--from`)를 항상 포함
- PTY `\r` 직접 의존 금지

## Session Communication

```bash
# List active sessions
telepty list

# Send message to another session
telepty inject --from aigentry-telepty-{cli} <target-session> "message"

# Report to orchestrator
telepty inject --ref --from aigentry-telepty-{cli} aigentry-orchestrator-claude "report"
```

## Work Principles

- **Best-First**: 항상 최선의 해결책 선택. 차선책/우회 금지.
- **Configurable**: 설정으로 제어 가능한 구조. 하드코딩 금지.
- **Evidence-Based**: 추측 금지. 데이터/로그/테스트 결과 기반 판단.
- **Fail Fast**: 에러 즉시 보고. 숨기지 않음.
- **Constitution**: ~/projects/aigentry/docs/CONSTITUTION.md 준수.
