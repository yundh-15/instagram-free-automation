// 기술분석 애널리스트 - 지표 기반 시그널 생성.
import { ema, rsi, macd } from '../lib/indicators.mjs';

export function analyze(closes, { symbol = 'KRW-BTC' } = {}) {
  const price = closes[closes.length - 1];
  const shortEma = ema(closes, 20);
  const longEma = ema(closes, 50);
  const rsiVal = rsi(closes, 14);
  const macdVal = macd(closes);

  // 데이터 부족 시 중립
  if (shortEma == null || longEma == null || rsiVal == null || macdVal == null) {
    return { symbol, signal: 'neutral', confidence: 0, price, indicators: {}, rationale: '데이터 부족' };
  }

  let score = 0;
  const reasons = [];

  if (shortEma > longEma) { score += 1; reasons.push('단기EMA>장기EMA(상승추세)'); }
  else { score -= 1; reasons.push('단기EMA<장기EMA(하락추세)'); }

  if (rsiVal < 30) { score += 1; reasons.push(`RSI ${rsiVal.toFixed(1)} 과매도`); }
  else if (rsiVal > 70) { score -= 1; reasons.push(`RSI ${rsiVal.toFixed(1)} 과매수`); }

  if (macdVal.hist > 0) { score += 1; reasons.push('MACD 히스토그램 양(+)'); }
  else { score -= 1; reasons.push('MACD 히스토그램 음(-)'); }

  const signal = score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral';
  const confidence = Math.min(1, Math.abs(score) / 3);

  return {
    symbol,
    signal,
    confidence,
    price,
    entry: price,
    stop_loss: +(price * 0.97).toFixed(2),
    take_profit: +(price * 1.06).toFixed(2),
    indicators: { shortEma, longEma, rsi: rsiVal, macd: macdVal },
    rationale: reasons.join(' / '),
  };
}
