#!/usr/bin/env node
// 단일 의사결정 사이클 러너 (클라우드 cron/자동화용).
// 상태를 파일에 영속화해, cron 이 호출될 때마다 '연속' 운용된다.
//
// 흐름: 상태 로드 → 최신 시세 조회 → 리서치 신호 로드 → 1 사이클 실행 → 상태 저장 → 로그.
//
// 사용법:
//   node coin/run-cycle.mjs                       # 기본: paper, upbit 실데이터(실패 시 합성)
//   node coin/run-cycle.mjs --source synthetic    # 합성 데이터(테스트)
//   COIN_SYMBOL=KRW-ETH node coin/run-cycle.mjs
//
// 환경변수: COIN_SYMBOL, COIN_SOURCE, COIN_STATE(상태파일 경로)
import { DEFAULT_CONFIG } from './config.mjs';
import { equity, rolloverDay } from './lib/portfolio.mjs';
import { fetchUpbitCloses, generateSyntheticCloses } from './lib/feed.mjs';
import { loadResearchSignal } from './lib/research-feed.mjs';
import { loadState, saveState, appendRunLog } from './lib/state-store.mjs';
import { runCycle } from './orchestrator.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

function parseArgs(argv) {
  const args = {
    symbol: process.env.COIN_SYMBOL || DEFAULT_CONFIG.symbol,
    source: process.env.COIN_SOURCE || 'upbit',
    state: process.env.COIN_STATE || 'data/coin-runs/state.json',
    research: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--symbol') args.symbol = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--state') args.state = argv[++i];
    else if (a === '--no-research') args.research = false;
  }
  return args;
}

async function loadCloses(args) {
  if (args.source === 'synthetic') {
    return { closes: generateSyntheticCloses({ count: 200, seed: Date.now() % 100000 }), source: 'synthetic' };
  }
  try {
    const closes = await fetchUpbitCloses({ symbol: args.symbol, unit: 60, count: 200 });
    return { closes, source: 'upbit' };
  } catch (err) {
    // 실데이터가 막히면(egress/지역제한) 작업을 죽이지 않고 합성으로 폴백 + 경고.
    console.warn(`[run-cycle] Upbit 실데이터 실패 → 합성 폴백: ${err.message}`);
    return { closes: generateSyntheticCloses({ count: 200, seed: Date.now() % 100000 }), source: 'synthetic-fallback' };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const { policy } = DEFAULT_CONFIG;
  const symbol = args.symbol;

  const { portfolio: pf, meta } = loadState(args.state, { startCash: DEFAULT_CONFIG.startCash });
  const { closes, source } = await loadCloses(args);
  const price = closes[closes.length - 1];

  // 리서치 브리지 신호(있으면 반영, 없으면 중립)
  let extraSignals = {};
  if (args.research) {
    const sig = loadResearchSignal(symbol);
    extraSignals = { research: sig.research, sentiment: sig.sentiment };
  }

  // 1 사이클 실행
  const ts = new Date().toISOString();
  const { order, riskReview, execution, protective } = runCycle(closes, pf, {
    symbol, policy, mode: 'paper', ts, extraSignals,
  });

  // 일일 손실 기준 리셋(하루 경과 시)
  const cyclesPerDay = policy.cyclesPerDay ?? 24;
  meta.cycles = (meta.cycles ?? 0) + 1;
  if (meta.cycles % cyclesPerDay === 0) rolloverDay(pf, { [symbol]: price });

  const eq = equity(pf, { [symbol]: price });
  saveState(args.state, pf, meta);

  // 로그 + 최신 요약
  const record = {
    symbol, source, price,
    action: order.action,
    status: execution.status,
    protective: protective ?? null,
    filled: execution.filled ?? null,
    decision: riskReview.decision,
    equity: Math.round(eq),
    cash: Math.round(pf.cash),
    realizedPnl: Math.round(pf.realizedPnl),
    research: extraSignals.research?.score ?? null,
  };
  appendRunLog('data/coin-runs/log.jsonl', record);
  mkdirSync('data/coin-runs', { recursive: true });
  writeFileSync('data/coin-runs/latest.json', JSON.stringify({ ts, ...record }, null, 2) + '\n');

  console.log(
    `[${ts}] ${symbol} ${source} @${Math.round(price)} → ` +
      `${order.action.toUpperCase()}${protective ? `(${protective})` : ''} ` +
      `[${execution.status}/${riskReview.decision}] ` +
      `equity=${Math.round(eq).toLocaleString()} pnl=${Math.round(pf.realizedPnl).toLocaleString()}`,
  );
}

main().catch((err) => {
  console.error('[run-cycle] 오류:', err.message);
  process.exit(1);
});
