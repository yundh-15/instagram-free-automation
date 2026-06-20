# 리서치 신호 브리지 (LLM → 코드 루프)

리서치 애널리스트(Claude 서브에이전트 `research-analyst`)가 분석 결과를 이 디렉터리에
`research-<SYMBOL>.json` 으로 기록하면, 매매 루프(`coin/`)가 읽어 CIO 의사결정에 반영한다.

- 경로 예: `research-KRW-BTC.json`
- 읽는 쪽: `coin/lib/research-feed.mjs` → `coin/agents/cio.mjs` (가중 반영)

## 스키마
| 필드 | 의미 |
|------|------|
| `symbol` | 마켓 코드 (예: `KRW-BTC`) |
| `ts` | 작성 시각(ISO 8601). 신선도(TTL) 판정에 사용 |
| `ttl_minutes` | 유효 시간(분). 초과 시 루프가 신호를 무시(중립 처리) |
| `score` | **통합 정성 점수 (-1 ~ 1)**. CIO 가 기술 신뢰도에 0.3 가중으로 반영 |
| `fundamental` | 펀더멘털 관점(view/conviction/key_drivers/risks) |
| `sentiment.score` | 심리 점수(-1 ~ 1) |
| `sentiment.alert` | `true` 시 CIO 가 **신규 진입 보류**(리스크 오프). 청산은 허용 |

## 페일세이프
파일이 없거나·깨졌거나·TTL 초과면 루프는 **중립(score 0)** 으로 처리해 영향 없이 동작한다.
즉, 리서치가 없어도 매매는 안전하게 돌고, 있으면 의사결정을 보정한다.

> 본 디렉터리의 `research-KRW-BTC.json` 은 데모용 샘플이다. 실제로는 `research-analyst` 가 갱신한다.
