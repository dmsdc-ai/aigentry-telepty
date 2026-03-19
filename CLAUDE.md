# telepty — PTY Multiplexer & Session Orchestrator

aigentry 에코시스템의 **통신 인프라**. 멀티 AI 세션을 생성·연결·제어하는 PTY 멀티플렉서.

## 에코시스템 내 역할

9개 aigentry 세션(orchestrator, brain, amplify, dustcraw 등) 간 통신을 담당:
- 세션 생성/관리 (`allow`, `spawn`)
- 메시지 전달 (`inject`, `broadcast`, `multicast`, `reply`)
- 실시간 모니터링 (`tui`, `monitor`, `listen`)
- 세션 간 토론 조율 (`deliberate`)

## 아키텍처

```
CLI (cli.js) ──→ HTTP/WS ──→ Daemon (daemon.js:3848)
                                ├── Session WS (/api/sessions/:id)
                                ├── Event Bus WS (/api/bus)
                                └── REST API (/api/sessions/*)
```

### 핵심 모듈

| 파일 | 줄수 | 역할 |
|------|------|------|
| `cli.js` | ~1950 | CLI 명령 + allow-bridge (PTY 래핑) |
| `daemon.js` | ~1550 | HTTP/WS 서버, 세션 상태, inject 전달 |
| `tui.js` | ~500 | blessed 기반 TUI 대시보드 |
| `session-routing.js` | 81 | 세션 ID 해석, alias 매칭, 호스트 그룹핑 |
| `daemon-control.js` | 223 | 싱글톤 daemon PID 관리 |
| `auth.js` | 33 | UUID 토큰 기반 인증 |
| `interactive-terminal.js` | 71 | raw mode stdin/stdout 관리 |
| `skill-installer.js` | 269 | Claude/Codex/Gemini 스킬 설치 |

### Inject 전달 경로 (wrapped session)

1. **Primary**: `kitty @ send-text` (터미널 직접 전달, allow-bridge 우회)
2. **Fallback**: WS → allow-bridge → `child.write()` (PTY)
3. **Submit**: `osascript` Return 키 → kitty fallback → WS `\r`

busy 세션: CR은 큐에 대기 중인 텍스트와 함께 큐잉 후 올바른 순서로 flush.

## 명령어

```bash
# 테스트
npm test                    # 43 tests (node:test)

# 실행
telepty daemon              # daemon 시작 (포트 3848)
telepty allow --id <name> claude  # 세션 래핑
telepty tui                 # TUI 대시보드
telepty list                # 세션 목록
telepty inject <id> "msg"   # 메시지 주입
telepty broadcast "msg"     # 전체 브로드캐스트
telepty session start --launch  # kitty 탭으로 다중 세션 시작

# 릴리스
npm version patch --no-git-tag-version && npm publish --access public
```

## 주요 규칙

- inject 후 submit은 항상 `osascript`로 통일 (`--no-enter` + osascript keystroke)
- inject 시 발신자 session ID (`--from`)를 항상 포함
- PTY `\r` 직접 의존 금지

## 최근 주요 변경 (v0.1.58–0.1.62)

| 버전 | 변경 |
|------|------|
| 0.1.62 | TUI 태스크 추적 — bus 이벤트에서 [태그] 자동 파싱, 세션별 상태 표시 |
| 0.1.61 | reconnect 시 resize/\x0c 제거 (멀티터미널 깜빡임 수정) |
| 0.1.60 | TUI P1 — s=start, k=kill, p=purge stale |
| 0.1.59 | wrapped inject 503 반환 + 테스트 43/43 정합성 |
| 0.1.58 | inject busy-session CR/text 순서 수정 + kittyWindowId 캐시 무효화 |

## 자율 재귀적 오케스트레이션

이 세션은 작업 복잡도가 높거나, 독립 도메인이 식별되거나, 컨텍스트 분리가 필요하다고 판단되면 — 사용자 지시 없이 자율적으로:

1. 자기 프로젝트 하위에 폴더를 생성한다
2. 해당 폴더에 CLAUDE.md를 작성한다 (역할, 범위, 상위 세션과의 통신 방법)
3. aigentry scaffold 또는 telepty allow로 하위 Claude 세션을 생성한다
4. telepty inject로 하위 세션에 태스크를 주입한다
5. 하위 세션의 결과를 수신하고 통합한다

판단 기준:
- 현재 작업이 2개 이상 독립 도메인을 포함할 때
- 컨텍스트 윈도우의 30% 이상을 단일 하위 작업이 차지할 때
- 반복적 전문 작업이 식별될 때 (SEO, 특정 채널, 특정 데이터 소스 등)

원칙:
- YAGNI: 진짜 필요할 때만 생성. 과잉 분리 금지.
- 하위 세션 완료 시 오케스트레이터(상위)에게 반드시 보고.
- 하위 세션의 결과물은 상위 프로젝트에 통합(커밋).
