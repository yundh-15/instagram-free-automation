// 오케스트레이터 - 한 번의 의사결정 사이클을 조율한다.
// 흐름: [보호 청산 점검] → 분석(기술/리서치) → CIO 종합 → 리스크 매니저 검증 → 트레이딩 데스크 집행.
import { analyze } from './agents/technical-analyst.mjs';
import { decide } from './agents/cio.mjs';
import { review } from './agents/risk-manager.mjs';
import { execute } from './agents/trading-desk.mjs';
import { getPosition } from './lib/portfolio.mjs';

// 보호 청산: 보유 포지션이 손절/익절 라인을 건드리면 시그널과 무관하게 즉시 청산.
// 시그널이 꺾이기를 기다리지 않으므로 급락 시 손실을 제한한다.
function protectiveExit(pf, symbol, price) {
  const pos = getPosition(pf, symbol);
  if (pos.size <= 0) return null;
  if (pos.stopLoss > 0 && price <= pos.stopLoss) return 'stop_loss';
  if (pos.takeProfit > 0 && price >= pos.takeProfit) return 'take_profit';
  return null;
}

// closes: 종가 시계열. extraSignals: { research?, sentiment? } (선택)
export function runCycle(closes, pf, { symbol = 'KRW-BTC', policy, mode = 'paper', ts = null, extraSignals = {} } = {}) {
  const price = closes[closes.length - 1];

  // 0) 보호 청산(손절/익절)을 시그널보다 먼저 점검
  const exitReason = protectiveExit(pf, symbol, price);
  if (exitReason) {
    const pos = getPosition(pf, symbol);
    const order = {
      action: 'sell',
      symbol,
      size: pos.size,
      price,
      rationale: `보호 청산(${exitReason})`,
    };
    const riskReview = review(order, pf, { policy });
    const execution = execute(order, riskReview, pf, { mode, policy, ts });
    return { technical: null, order, riskReview, execution, protective: exitReason };
  }

  // 1) 애널리스트 분석
  const technical = analyze(closes, { symbol });
  const signals = { technical, ...extraSignals };

  // 2) CIO 결정안
  const order = decide(signals, pf, { symbol, policy });

  // 3) 리스크 매니저 검증 (거부권)
  const riskReview = review(order, pf, { policy });

  // 4) 트레이딩 데스크 집행 (승인 시에만)
  const execution = execute(order, riskReview, pf, { mode, policy, ts });

  return { technical, order, riskReview, execution, protective: null };
}
