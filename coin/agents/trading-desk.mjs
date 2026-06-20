// 트레이딩 데스크 - 승인된 주문만 집행. 기본은 페이퍼(모의).
import { applyFill } from '../lib/portfolio.mjs';

// review: 리스크 매니저 결과. order: CIO 결정안. price: 현재가.
export function execute(order, review, pf, { mode = 'paper', policy, ts = null } = {}) {
  // 승인 없는 주문은 절대 실행하지 않는다.
  if (!review || (review.decision !== 'approve' && review.decision !== 'reduce')) {
    return { status: 'rejected', message: review?.rationale ?? '리스크 승인 없음', filled: null };
  }
  const size = review.approved_size;
  if (!(size > 0)) {
    return { status: 'rejected', message: '승인 수량 0', filled: null };
  }

  if (mode === 'live') {
    // 실거래는 별도 어댑터(Upbit MCP/REST)로 연결해야 한다. 안전상 기본 차단.
    return { status: 'error', message: 'live 모드 미연결: Upbit 주문 어댑터가 필요합니다.', filled: null };
  }

  // ── 페이퍼 체결 ──
  const side = order.action === 'buy' ? 'bid' : 'ask';
  const slip = policy?.slippagePct ?? 0.0005;
  const fillPrice = side === 'bid' ? order.price * (1 + slip) : order.price * (1 - slip);
  const fill = {
    symbol: order.symbol,
    side,
    size,
    price: +fillPrice.toFixed(2),
    ts,
    // 매수 시 손절/익절 라인을 포지션에 함께 기록
    stopLoss: order.stop_loss,
    takeProfit: order.take_profit,
  };
  applyFill(pf, fill);

  return {
    status: review.decision === 'reduce' ? 'partial' : 'filled',
    message: 'paper fill',
    requested: { side, size: order.size, price: order.price },
    filled: fill,
    slippage: slip,
  };
}
