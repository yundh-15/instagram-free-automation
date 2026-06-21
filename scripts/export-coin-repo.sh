#!/usr/bin/env bash
# 코인 에이전트 팀을 '독립 레포'로 내보낸다.
# 코드/에이전트/테스트/워크플로우를 모아 자족형 프로젝트 디렉터리를 만들고 git 초기화까지 한다.
#
# 사용법:
#   bash scripts/export-coin-repo.sh [대상디렉터리]
#   (기본 대상: ./coin-agent-team-export)
#
# 결과 디렉터리에서:
#   git remote add origin <새-레포-URL>
#   git push -u origin main
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$SRC/coin-agent-team-export}"

echo "[*] 소스: $SRC"
echo "[*] 대상: $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"

# ── 코드/에이전트/신호/도구 복사 ──
cp -R "$SRC/coin" "$DEST/coin"
mkdir -p "$DEST/.claude"
cp -R "$SRC/.claude/agents" "$DEST/.claude/agents"
mkdir -p "$DEST/data/coin-signals"
cp "$SRC/data/coin-signals/README.md" "$DEST/data/coin-signals/"
cp "$SRC/data/coin-signals/research-KRW-BTC.json" "$DEST/data/coin-signals/"
mkdir -p "$DEST/tests"
cp "$SRC/tests/coin.test.mjs" "$DEST/tests/"
cp "$SRC/.mcp.json" "$DEST/.mcp.json"
mkdir -p "$DEST/scripts"
cp "$SRC/scripts/setup-upbit-mcp.sh" "$DEST/scripts/"
[ -f "$SRC/docs/coin-agent-team-plan.md" ] && { mkdir -p "$DEST/docs"; cp "$SRC/docs/coin-agent-team-plan.md" "$DEST/docs/"; }

# ── 독립 프로젝트 메타 파일 생성 ──
cat > "$DEST/package.json" <<'JSON'
{
  "name": "coin-agent-team",
  "version": "1.0.0",
  "description": "코인 투자 멀티 에이전트 팀 (페이퍼 트레이딩 + 클라우드 자동화).",
  "type": "module",
  "scripts": {
    "paper": "node coin/paper-trade.mjs",
    "cycle": "node coin/run-cycle.mjs",
    "setup-upbit-mcp": "bash scripts/setup-upbit-mcp.sh",
    "test": "node --test tests/*.test.mjs"
  },
  "license": "ISC"
}
JSON

cat > "$DEST/.gitignore" <<'GIT'
node_modules/
.env
*.log
__pycache__/
.venv*/
vendor/
# 런타임 상태/요약은 자동화 워크플로우가 커밋한다(필요 시 주석 해제)
# data/coin-runs/
GIT

cat > "$DEST/.env.example" <<'ENV'
# Upbit 개발자센터(https://upbit.com/mypage/open_api_management)에서 발급. 절대 커밋 금지.
UPBIT_ACCESS_KEY=
UPBIT_SECRET_KEY=
ENV

# ── 클라우드 자동화 워크플로우 (이 독립 레포 전용) ──
mkdir -p "$DEST/.github/workflows"
cat > "$DEST/.github/workflows/coin-trading.yml" <<'YML'
name: Coin Trading Loop

# 코인 에이전트 팀의 페이퍼 트레이딩 루프를 클라우드에서 주기 실행한다.
# - PC 없이 GitHub 클라우드에서 동작 → 모바일(GitHub 앱)에서 트리거·결과 확인.
# - 핫패스는 순수 코드라 LLM 토큰/ANTHROPIC_API_KEY 불필요.
# - 기본 paper 모드(모의). 상태는 data/coin-runs/state.json 에 연속 저장.

on:
  schedule:
    - cron: '13 */1 * * *'   # 매시간(정시 혼잡 회피)
  workflow_dispatch:
    inputs:
      source:
        description: 데이터원 (upbit | synthetic)
        required: false
        default: upbit
      symbol:
        description: 마켓 코드 (예 KRW-BTC)
        required: false
        default: KRW-BTC

permissions:
  contents: write

concurrency:
  group: coin-trading
  cancel-in-progress: false

jobs:
  cycle:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      UPBIT_ACCESS_KEY: ${{ secrets.UPBIT_ACCESS_KEY }}
      UPBIT_SECRET_KEY: ${{ secrets.UPBIT_SECRET_KEY }}
      COIN_SYMBOL: ${{ github.event.inputs.symbol || 'KRW-BTC' }}
      COIN_SOURCE: ${{ github.event.inputs.source || 'upbit' }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '22'
      - name: Run tests
        run: npm test
      - name: Run one trading cycle
        run: node coin/run-cycle.mjs
      - name: Commit run state
        run: |
          if git diff --quiet -- data/coin-runs; then
            echo "변경 없음"; exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data/coin-runs
          git commit -m "코인 사이클 기록 [skip ci]"
          git push
      - name: Upload latest summary
        uses: actions/upload-artifact@v6
        if: always()
        with:
          name: coin-latest
          path: data/coin-runs/latest.json
          if-no-files-found: ignore
YML

# 자동화가 상태를 커밋할 수 있도록 data/coin-runs 는 추적(빈 디렉터리 방지)
mkdir -p "$DEST/data/coin-runs"
cat > "$DEST/data/coin-runs/.gitkeep" <<'EOF'
EOF

cat > "$DEST/README.md" <<'MD'
# 코인 투자 에이전트 팀 (독립 레포)

기술분석·리서치·리스크·실행을 분리한 멀티 에이전트 팀 + 결정적 코드 매매 루프.
인스타그램 자동화와 **완전히 분리된** 독립 프로젝트다.

## 빠른 시작
```bash
npm test                 # 전체 테스트
npm run paper            # 페이퍼 트레이딩 시뮬레이션(합성 데이터)
node coin/run-cycle.mjs --source synthetic   # 단일 사이클(상태 저장)
```

## 구성
- `coin/` — 매매 엔진(지표/포트폴리오/리스크/실행/오케스트레이터)
- `.claude/agents/` — 6인 LLM 서브에이전트 정의(토큰 효율 호출 정책 포함)
- `data/coin-signals/` — 리서치 LLM ↔ 코드 루프 브리지
- `.github/workflows/coin-trading.yml` — 클라우드 자동화(cron)

## 자동화 (모바일/PC 무관)
GitHub Actions 가 클라우드에서 `run-cycle.mjs` 를 주기 실행한다. PC가 꺼져 있어도 동작하고,
모바일 GitHub 앱에서 실행/결과 확인이 가능하다. 핫패스는 순수 코드라 LLM 토큰이 들지 않는다.

### 설정
1. 레포 Settings → Secrets → `UPBIT_ACCESS_KEY`, `UPBIT_SECRET_KEY` 등록(실데이터/주문용).
2. (실거래) Upbit 주문 API는 IP 화이트리스트가 필요 → GitHub 클라우드 러너는 IP가 유동적이라
   **기본 paper 모드** 권장. 실거래는 고정 IP(자체 호스트 러너/프록시)에서.

## PC 에서 MCP (대화형)
`.mcp.json` 에 Upbit MCP 서버가 등록돼 있다. `bash scripts/setup-upbit-mcp.sh` 로 설치 후
Claude Code(PC)에서 세션을 재시작하면 조회/주문 도구를 쓸 수 있다.

> ⚠️ 자동화 설계/모의 검증용이며 투자 자문이 아니다. 암호화폐는 고위험 자산이다.
MD

# ── git 초기화 + 초기 커밋 ──
cd "$DEST"
git init -q -b main
git add -A
git -c user.name="coin-export" -c user.email="coin@export.local" commit -q -m "코인 에이전트 팀 초기 커밋 (인스타 레포에서 분리)"

echo
echo "[OK] 독립 레포 준비 완료: $DEST"
echo
echo "다음 단계:"
echo "  cd \"$DEST\""
echo "  git remote add origin <새-코인-레포-URL>"
echo "  git push -u origin main"
