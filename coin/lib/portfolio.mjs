// 포트폴리오 상태 모델. 페이퍼/실거래 공용.

export function createPortfolio({ cash = 1_000_000 } = {}) {
  return {
    cash,
    startEquity: cash,
    dayStartEquity: cash,
    positions: {}, // sym -> { size, avgPrice }
    realizedPnl: 0,
    history: [],
  };
}

export function getPosition(pf, symbol) {
  return pf.positions[symbol] || { size: 0, avgPrice: 0, stopLoss: 0, takeProfit: 0 };
}

// 일일 손실 기준 리셋(하루 경과 시 호출). 킬 스위치가 실제 '일일' 기준으로 동작하게 한다.
export function rolloverDay(pf, prices) {
  pf.dayStartEquity = equity(pf, prices);
  return pf;
}

// 현재가 맵({sym: price})으로 총자산(현금 + 평가금액) 계산.
export function equity(pf, prices) {
  let value = pf.cash;
  for (const [sym, pos] of Object.entries(pf.positions)) {
    const price = prices[sym] ?? pos.avgPrice;
    value += pos.size * price;
  }
  return value;
}

// 체결(fill)을 포트폴리오에 반영. fill: { symbol, side, size, price }
export function applyFill(pf, fill) {
  const { symbol, side, size, price } = fill;
  const pos = getPosition(pf, symbol);

  if (side === 'bid') {
    const newSize = pos.size + size;
    const newAvg = newSize > 0 ? (pos.size * pos.avgPrice + size * price) / newSize : 0;
    pf.cash -= size * price;
    // 매수 시 손절/익절 라인을 포지션에 기록 → 이후 사이클에서 보호 청산에 사용.
    pf.positions[symbol] = {
      size: newSize,
      avgPrice: newAvg,
      stopLoss: fill.stopLoss ?? pos.stopLoss ?? 0,
      takeProfit: fill.takeProfit ?? pos.takeProfit ?? 0,
    };
  } else {
    const sellSize = Math.min(size, pos.size);
    pf.realizedPnl += (price - pos.avgPrice) * sellSize;
    pf.cash += sellSize * price;
    const remaining = pos.size - sellSize;
    pf.positions[symbol] = remaining > 0
      ? { size: remaining, avgPrice: pos.avgPrice, stopLoss: pos.stopLoss, takeProfit: pos.takeProfit }
      : { size: 0, avgPrice: 0, stopLoss: 0, takeProfit: 0 }; // 전량 청산 시 보호선 초기화
  }

  pf.history.push({ ts: fill.ts ?? null, ...fill });
  return pf;
}
