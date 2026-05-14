@AGENTS.md

# Claude-specific notes — aigentry-telepty

- Session ID: `aigentry-telepty-claude`
- Changelog / version history: see `CHANGELOG.md` and `package.json` (canonical). Do not duplicate here.
- Module roles and inject delivery paths: see `AGENTS.md`.

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
