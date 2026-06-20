// 오케스트레이터 - 한 번의 의사결정 사이클을 조율한다.
// 흐름: 분석(기술/심리/리서치) → CIO 종합 → 리스크 매니저 검증 → 트레이딩 데스크 집행.
import { analyze } from './agents/technical-analyst.mjs';
import { decide } from './agents/cio.mjs';
import { review } from './agents/risk-manager.mjs';
import { execute } from './agents/trading-desk.mjs';

// closes: 종가 시계열. extraSignals: { sentiment?, research? } (선택)
export function runCycle(closes, pf, { symbol = 'KRW-BTC', policy, mode = 'paper', ts = null, extraSignals = {} } = {}) {
  // 1) 애널리스트 분석
  const technical = analyze(closes, { symbol });
  const signals = { technical, ...extraSignals };

  // 2) CIO 결정안
  const order = decide(signals, pf, { symbol, policy });

  // 3) 리스크 매니저 검증 (거부권)
  const riskReview = review(order, pf, { policy });

  // 4) 트레이딩 데스크 집행 (승인 시에만)
  const execution = execute(order, riskReview, pf, { mode, policy, ts });

  return { technical, order, riskReview, execution };
}
