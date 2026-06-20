// 리스크 매니저(CRO) - 주문 사전 검증 게이트. 위반 시 거부(veto).
import { getPosition, equity } from '../lib/portfolio.mjs';

// 반환: { decision: 'approve'|'reduce'|'reject', approved_size, violations[], rationale }
export function review(order, pf, { policy } = {}) {
  const violations = [];
  const price = order.price;
  const eq = equity(pf, { [order.symbol]: price });

  if (order.action === 'hold' || order.size <= 0) {
    return { decision: 'reject', approved_size: 0, violations: ['주문 없음(hold)'], rationale: '실행할 주문 없음' };
  }

  // 매도는 보유분 청산이므로 한도 검증 완화, 손절 요건 면제
  if (order.action === 'sell') {
    const pos = getPosition(pf, order.symbol);
    const sellSize = Math.min(order.size, pos.size);
    if (sellSize <= 0) {
      return { decision: 'reject', approved_size: 0, violations: ['보유 수량 없음'], rationale: '청산할 포지션 없음' };
    }
    return { decision: 'approve', approved_size: sellSize, violations: [], rationale: '청산 승인' };
  }

  // ── 이하 매수(buy) 검증 ──

  // 1) 킬 스위치: 일일 최대 손실 초과 시 신규 매수 차단
  const dailyLossLimit = pf.dayStartEquity * (1 - policy.dailyMaxLossPct);
  if (eq <= dailyLossLimit) {
    return {
      decision: 'reject',
      approved_size: 0,
      violations: [`일일 손실 한도 도달(킬 스위치): 자산 ${Math.round(eq)} <= ${Math.round(dailyLossLimit)}`],
      rationale: '오늘은 신규 진입 금지',
    };
  }

  // 2) 손절 필수
  if (policy.requireStopLoss && !(order.stop_loss > 0)) {
    violations.push('손절(stop_loss) 미설정');
  }

  // 3) 단일 종목 노출 한도
  const pos = getPosition(pf, order.symbol);
  const maxNotional = eq * policy.maxPositionPct;
  const currentNotional = pos.size * price;
  let approvedSize = order.size;
  const requestedNotional = order.size * price;

  if (currentNotional + requestedNotional > maxNotional) {
    const allowedNotional = Math.max(0, maxNotional - currentNotional);
    approvedSize = +(allowedNotional / price).toFixed(8);
    violations.push(`단일종목 한도 초과 → 축소(${order.size} → ${approvedSize})`);
  }

  // 4) 현금 한도
  const maxCash = pf.cash * policy.maxCashUsePct;
  if (approvedSize * price > maxCash) {
    approvedSize = +(maxCash / price).toFixed(8);
    violations.push('현금 한도 초과 → 축소');
  }

  // 손절 미설정은 치명 → 거부
  if (policy.requireStopLoss && !(order.stop_loss > 0)) {
    return { decision: 'reject', approved_size: 0, violations, rationale: '손절 없는 주문 거부' };
  }

  if (approvedSize <= 0) {
    return { decision: 'reject', approved_size: 0, violations, rationale: '승인 가능 수량 0' };
  }

  // 최소 주문 금액 미만이면 거부(먼지 주문 방지)
  if (policy.minOrderKRW && approvedSize * price < policy.minOrderKRW) {
    violations.push(`최소 주문금액 미만(${Math.round(approvedSize * price)} < ${policy.minOrderKRW})`);
    return { decision: 'reject', approved_size: 0, violations, rationale: '최소 주문금액 미만' };
  }

  const decision = approvedSize < order.size ? 'reduce' : 'approve';
  return { decision, approved_size: approvedSize, violations, rationale: decision === 'reduce' ? '한도 내 축소 승인' : '승인' };
}
