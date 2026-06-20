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
  return pf.positions[symbol] || { size: 0, avgPrice: 0 };
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
    pf.positions[symbol] = { size: newSize, avgPrice: newAvg };
  } else {
    const sellSize = Math.min(size, pos.size);
    pf.realizedPnl += (price - pos.avgPrice) * sellSize;
    pf.cash += sellSize * price;
    const remaining = pos.size - sellSize;
    pf.positions[symbol] = { size: remaining, avgPrice: remaining > 0 ? pos.avgPrice : 0 };
  }

  pf.history.push({ ts: fill.ts ?? null, ...fill });
  return pf;
}
