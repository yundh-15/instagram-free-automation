import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sma, ema, rsi, macd } from '../coin/lib/indicators.mjs';
import { createPortfolio, applyFill, equity, getPosition, rolloverDay } from '../coin/lib/portfolio.mjs';
import { analyze } from '../coin/agents/technical-analyst.mjs';
import { review } from '../coin/agents/risk-manager.mjs';
import { execute } from '../coin/agents/trading-desk.mjs';
import { runCycle } from '../coin/orchestrator.mjs';
import { generateSyntheticCloses } from '../coin/lib/feed.mjs';
import { DEFAULT_POLICY } from '../coin/config.mjs';

test('indicators: SMA/EMA/RSI/MACD 기본 동작', () => {
  const vals = Array.from({ length: 60 }, (_, i) => 100 + i);
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.ok(ema(vals, 10) > 100);
  // 단조 증가 → RSI 100 근처
  assert.ok(rsi(vals, 14) > 99);
  const m = macd(vals);
  assert.ok(m && typeof m.hist === 'number');
});

test('portfolio: 매수/매도 체결과 실현손익', () => {
  const pf = createPortfolio({ cash: 1_000_000 });
  applyFill(pf, { symbol: 'KRW-BTC', side: 'bid', size: 0.01, price: 50_000_000 });
  assert.equal(getPosition(pf, 'KRW-BTC').size, 0.01);
  assert.equal(pf.cash, 500_000);
  applyFill(pf, { symbol: 'KRW-BTC', side: 'ask', size: 0.01, price: 60_000_000 });
  assert.equal(getPosition(pf, 'KRW-BTC').size, 0);
  assert.equal(pf.realizedPnl, 100_000); // (60M-50M)*0.01
  assert.equal(equity(pf, { 'KRW-BTC': 60_000_000 }), 1_100_000);
});

test('risk-manager: 손절 없는 매수는 거부', () => {
  const pf = createPortfolio({ cash: 1_000_000 });
  const order = { action: 'buy', symbol: 'KRW-BTC', size: 0.001, price: 50_000_000, stop_loss: 0 };
  const r = review(order, pf, { policy: DEFAULT_POLICY });
  assert.equal(r.decision, 'reject');
  assert.ok(r.violations.some((v) => v.includes('손절')));
});

test('risk-manager: 단일종목 한도 초과 시 축소', () => {
  const pf = createPortfolio({ cash: 10_000_000 });
  // 한도 20% = 2,000,000 → 0.1 BTC@50M = 5,000,000 요청은 축소돼야 함
  const order = { action: 'buy', symbol: 'KRW-BTC', size: 0.1, price: 50_000_000, stop_loss: 48_000_000 };
  const r = review(order, pf, { policy: DEFAULT_POLICY });
  assert.equal(r.decision, 'reduce');
  assert.ok(r.approved_size < 0.1);
  assert.ok(Math.abs(r.approved_size * 50_000_000 - 2_000_000) < 1);
});

test('trading-desk: 승인 없는 주문은 실행 안 됨', () => {
  const pf = createPortfolio({ cash: 1_000_000 });
  const order = { action: 'buy', symbol: 'KRW-BTC', size: 0.001, price: 50_000_000 };
  const r = { decision: 'reject', approved_size: 0 };
  const exec = execute(order, r, pf, { policy: DEFAULT_POLICY });
  assert.equal(exec.status, 'rejected');
  assert.equal(pf.cash, 1_000_000); // 변동 없음
});

test('trading-desk: 페이퍼 체결은 슬리피지 반영', () => {
  const pf = createPortfolio({ cash: 1_000_000 });
  const order = { action: 'buy', symbol: 'KRW-BTC', size: 0.001, price: 50_000_000 };
  const r = { decision: 'approve', approved_size: 0.001 };
  const exec = execute(order, r, pf, { policy: DEFAULT_POLICY });
  assert.equal(exec.status, 'filled');
  assert.ok(exec.filled.price > 50_000_000); // 매수 슬리피지 +
});

test('orchestrator: 상승 추세에서 매수 사이클 동작', () => {
  const closes = generateSyntheticCloses({ count: 120, trend: 0.004, vol: 0.005, seed: 1 });
  const pf = createPortfolio({ cash: 1_000_000 });
  const out = runCycle(closes, pf, { symbol: 'KRW-BTC', policy: DEFAULT_POLICY, mode: 'paper' });
  assert.ok(['buy', 'sell', 'hold'].includes(out.order.action));
  assert.ok(out.technical.signal);
  // 결과는 항상 구조화돼 반환된다
  assert.ok(out.riskReview.decision);
});

test('analyze: 데이터 부족 시 중립', () => {
  const a = analyze([100, 101, 102], { symbol: 'KRW-BTC' });
  assert.equal(a.signal, 'neutral');
  assert.equal(a.confidence, 0);
});

test('보호 청산: 손절선 도달 시 시그널과 무관하게 청산', () => {
  // 50M 워밍업 후 매수가 일어나는 상승 구간을 만들고, 마지막에 손절선 아래로 급락시킨다.
  const up = generateSyntheticCloses({ count: 120, trend: 0.004, vol: 0.003, seed: 3 });
  const pf = createPortfolio({ cash: 1_000_000 });
  // 강제로 포지션 + 손절선 세팅
  applyFill(pf, { symbol: 'KRW-BTC', side: 'bid', size: 0.01, price: 50_000_000, stopLoss: 49_000_000, takeProfit: 60_000_000 });
  assert.equal(getPosition(pf, 'KRW-BTC').stopLoss, 49_000_000);
  // 현재가가 손절선 아래 → 보호 청산되어야 함
  const closes = [...up.slice(0, 119), 48_000_000];
  const out = runCycle(closes, pf, { symbol: 'KRW-BTC', policy: DEFAULT_POLICY, mode: 'paper' });
  assert.equal(out.protective, 'stop_loss');
  assert.equal(out.execution.status, 'filled');
  assert.equal(getPosition(pf, 'KRW-BTC').size, 0); // 청산 완료
});

test('보호 청산: 익절선 도달 시 청산', () => {
  const pf = createPortfolio({ cash: 1_000_000 });
  applyFill(pf, { symbol: 'KRW-BTC', side: 'bid', size: 0.01, price: 50_000_000, stopLoss: 48_000_000, takeProfit: 55_000_000 });
  const closes = [...generateSyntheticCloses({ count: 119, seed: 5 }), 56_000_000];
  const out = runCycle(closes, pf, { symbol: 'KRW-BTC', policy: DEFAULT_POLICY, mode: 'paper' });
  assert.equal(out.protective, 'take_profit');
  assert.equal(getPosition(pf, 'KRW-BTC').size, 0);
});

test('risk-manager: 최소 주문금액 미만 매수는 거부', () => {
  const pf = createPortfolio({ cash: 1_000_000 });
  // 0.00001 BTC @50M = 500원 < 5000원 최소금액
  const order = { action: 'buy', symbol: 'KRW-BTC', size: 0.00001, price: 50_000_000, stop_loss: 48_000_000 };
  const r = review(order, pf, { policy: DEFAULT_POLICY });
  assert.equal(r.decision, 'reject');
  assert.ok(r.violations.some((v) => v.includes('최소 주문금액')));
});

test('portfolio: rolloverDay 가 일일 기준을 현재 자산으로 리셋', () => {
  const pf = createPortfolio({ cash: 1_000_000 });
  applyFill(pf, { symbol: 'KRW-BTC', side: 'bid', size: 0.01, price: 50_000_000 });
  // 평가익 반영된 현재 자산으로 dayStartEquity 갱신
  rolloverDay(pf, { 'KRW-BTC': 60_000_000 });
  assert.equal(pf.dayStartEquity, equity(pf, { 'KRW-BTC': 60_000_000 }));
  assert.notEqual(pf.dayStartEquity, pf.startEquity);
});
