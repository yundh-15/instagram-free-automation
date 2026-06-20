# 코인 투자 에이전트 팀 — 실행 코드

기획서([`docs/coin-agent-team-plan.md`](../docs/coin-agent-team-plan.md))의 6인 팀과 의사결정 흐름(분석 → CIO → 리스크 → 집행)을 Node 코드로 구현한 모듈입니다.

> 두 가지 계층이 있습니다.
> - **Claude 서브에이전트** (`.claude/agents/`): 판단·리서치·해석 등 고차원 역할(대화형).
> - **코드 파이프라인** (`coin/`): 결정적이고 테스트 가능한 매매 루프(자동 실행). 본 디렉터리.

## 구조

```
coin/
├── config.mjs              # 설정 + 리스크 정책(기본 보수적, 기본 모드=paper)
├── orchestrator.mjs        # 한 사이클 조율: 분석→CIO→리스크→집행
├── paper-trade.mjs         # 페이퍼 트레이딩 루프 (CLI)
├── lib/
│   ├── indicators.mjs      # SMA/EMA/RSI/MACD
│   ├── portfolio.mjs       # 포지션·현금·실현손익 상태
│   └── feed.mjs            # 합성 데이터 + Upbit 실데이터 어댑터
└── agents/
    ├── technical-analyst.mjs  # 지표 → 시그널
    ├── cio.mjs                # 시그널 종합 → 결정안
    ├── risk-manager.mjs       # 사전 검증·거부권(veto)
    └── trading-desk.mjs       # 승인된 주문만 집행(기본 페이퍼)
```

## 실행

```bash
# 합성 데이터로 모의 매매 (네트워크 불필요)
npm run coin:paper

# 옵션
node coin/paper-trade.mjs --cycles 200 --seed 7
node coin/paper-trade.mjs --symbol KRW-ETH

# Upbit 실데이터 (egress 허용 + 키 필요)
node coin/paper-trade.mjs --source upbit --symbol KRW-BTC

# 테스트
npm test
```

## 안전장치 (코드로 강제)
- **보호 청산(손절/익절)**: 보유 포지션이 손절선/익절선을 건드리면 시그널과 무관하게 즉시 청산(`orchestrator.mjs`). 손절을 "설정만" 하지 않고 실제로 실행한다.
- **리스크 매니저 거부권**: 손절 없는 매수 거부, 단일종목 한도 초과 시 축소, 일일 손실 한도(킬 스위치), 최소 주문금액(5,000원) 미만 거부.
- **일일 기준 리셋**: `rolloverDay()` 로 하루 경과 시 일일 손실 기준을 갱신(킬 스위치가 실제 '일일' 기준으로 동작).
- **먼지 주문 방지**: 목표비중까지의 잔여가 최소 주문금액 미만이면 매수하지 않음(잦은 미세 체결 제거).
- **승인 게이트**: 트레이딩 데스크는 리스크 승인(`approve`/`reduce`) 없이는 절대 체결하지 않음.
- **기본 페이퍼 모드**: `live` 는 별도 Upbit 주문 어댑터 연결 전까지 차단.

## 알려진 한계 (정직성)
- **LLM 서브에이전트(`.claude/agents/`)는 이 자동 루프에 아직 연결되지 않았다.** 현재 루프는 코드의 기술분석만 사용하며, 리서치/심리 점수(`extraSignals`)는 비어 있어 의사결정에 영향이 없다. 리서치 애널리스트를 루프에 반영하려면 별도 연동이 필요하다.

## Upbit 실데이터 연결 체크리스트
1. `scripts/setup-upbit-mcp.sh` 로 MCP 서버 설치(`npm run coin:setup-upbit-mcp`).
2. `.env` 에 `UPBIT_ACCESS_KEY` / `UPBIT_SECRET_KEY` 설정 (커밋 금지).
3. (원격 환경) 네트워크 송신 허용목록에 `api.upbit.com` 추가.
4. Claude Code 세션 재시작 → `.mcp.json` 의 `upbit` 서버 로드.

> ⚠️ 본 코드는 자동화 설계/모의 검증용이며 투자 자문이 아닙니다. 암호화폐는 고위험 자산입니다.
