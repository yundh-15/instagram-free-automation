// 최고투자책임자(CIO) - 애널리스트 시그널을 종합해 결정안 생성.
// 코드 파이프라인에서는 기술분석 시그널을 핵심으로 쓰되,
// sentiment/research 점수를 가중치로 추가 반영할 수 있게 한다.
import { getPosition, equity } from '../lib/portfolio.mjs';

// signals: { technical, sentiment?, research? }
export function decide(signals, pf, { symbol = 'KRW-BTC', policy } = {}) {
  const tech = signals.technical;
  const price = tech.price;
  const pos = getPosition(pf, symbol);
  const eq = equity(pf, { [symbol]: price });

  // 외부 점수(-1~1) 보정: 없으면 0
  const bias = (signals.sentiment?.score ?? 0) * 0.3 + (signals.research?.score ?? 0) * 0.3;
  const effectiveConf = Math.max(0, Math.min(1, tech.confidence + bias));

  let action = 'hold';
  let size = 0;
  const dissent = [];

  if (tech.signal === 'bullish' && effectiveConf > 0.3) {
    action = 'buy';
    // 목표 비중 = 단일종목 한도 * 신뢰도
    const targetNotional = eq * policy.maxPositionPct * effectiveConf;
    const currentNotional = pos.size * price;
    const addNotional = Math.max(0, targetNotional - currentNotional);
    // 최소 주문 금액 미만의 '탑업'은 하지 않는다(먼지 주문/잦은 체결 방지).
    if (addNotional < (policy.minOrderKRW ?? 0)) {
      action = 'hold';
      size = 0;
    } else {
      size = +(addNotional / price).toFixed(8);
      if (size <= 0) { action = 'hold'; }
    }
  } else if (tech.signal === 'bearish' && pos.size > 0) {
    action = 'sell';
    size = pos.size; // 보유분 청산
  }

  if (signals.sentiment?.alert) dissent.push('시장심리 급변 경보');

  return {
    action,
    symbol,
    size,
    confidence: +effectiveConf.toFixed(3),
    time_horizon: 'swing',
    rationale: tech.rationale,
    stop_loss: tech.stop_loss,
    take_profit: tech.take_profit,
    price,
    dissenting_signals: dissent,
  };
}
