# 코인 투자 에이전트 팀

기획서([`docs/coin-agent-team-plan.md`](../../docs/coin-agent-team-plan.md))에 정의된 8인 팀을 Claude Code 서브에이전트로 구현한 디렉터리입니다.

## 팀원

| 파일 | 직무 | 모델 | 사고 | 핵심 책임 |
|------|------|------|------|-----------|
| `cio.md` | 최고투자책임자(CIO) | opus | High | 의견 종합·최종 결정안 |
| `data-analyst.md` | 데이터 애널리스트 | haiku | Minimal | 시세·온체인 데이터 수집/정규화 |
| `technical-analyst.md` | 기술분석 애널리스트 | sonnet | Medium | 지표·차트 단기 시그널 |
| `research-analyst.md` | 리서치 애널리스트 | sonnet | Med~High | 펀더멘털·온체인·토크노믹스 |
| `sentiment-analyst.md` | 시장심리 애널리스트 | haiku | Low~Med | 뉴스·소셜·공포탐욕지수 |
| `risk-manager.md` | 리스크 매니저(CRO) | opus | High | 주문 사전 검증·거부권 |
| `quant-researcher.md` | 퀀트 리서처 | opus | High | 백테스트·전략 최적화 |
| `trading-desk.md` | 트레이딩 데스크 | haiku | Minimal | 승인된 주문 집행 |

## 의사결정 흐름 (1 사이클)

```
데이터/기술/리서치/심리 애널리스트  ──분석──▶  CIO  ──결정안──▶  리스크 매니저
                                                                    │ 승인
                                                                    ▼
                                                            트레이딩 데스크 ──▶ 거래소
                                                                    │
                                                              상태 갱신·감사 로그
퀀트 리서처 ── 비동기 백테스트 ──▶ 전략/파라미터 제안
```

## 운영 원칙
- **역할 분리**: 분석 / 결정(CIO) / 검증(리스크 매니저) / 실행(트레이딩 데스크)을 분리한다.
- **리스크 매니저 거부권**: 승인 없는 주문은 실행 불가.
- **페이퍼 트레이딩 우선**: 기본값은 모의. 검증 후 소액 실거래 → 한도 확대.
- **MVP 4인**: `cio` + `technical-analyst` + `risk-manager` + `trading-desk` 로 시작.

## 사용법
서브에이전트는 이름으로 호출합니다(예: `technical-analyst`, `risk-manager`).
실데이터 연동 시 Upbit MCP 서버를 런타임에 등록하면 데이터 애널리스트(조회)·트레이딩 데스크(주문)가 해당 도구를 사용합니다.
