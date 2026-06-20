#!/usr/bin/env node
// 페이퍼 트레이딩 루프 (CLI).
// 합성 데이터 또는 Upbit 실데이터(egress 허용 시) 위에서 전체 사이클을 반복 실행한다.
//
// 사용법:
//   node coin/paper-trade.mjs                         # 합성 데이터로 모의 실행
//   node coin/paper-trade.mjs --symbol KRW-ETH        # 종목 지정
//   node coin/paper-trade.mjs --source upbit          # 실데이터(키/egress 필요)
//   node coin/paper-trade.mjs --cycles 120 --seed 7   # 사이클 수/시드
import { DEFAULT_CONFIG } from './config.mjs';
import { createPortfolio, equity, rolloverDay } from './lib/portfolio.mjs';
import { generateSyntheticCloses, fetchUpbitCloses } from './lib/feed.mjs';
import { loadResearchSignal } from './lib/research-feed.mjs';
import { runCycle } from './orchestrator.mjs';

function parseArgs(argv) {
  const args = { source: 'synthetic', cycles: 150, seed: 42, symbol: DEFAULT_CONFIG.symbol, research: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--cycles') args.cycles = Number(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--symbol') args.symbol = argv[++i];
    else if (a === '--no-research') args.research = false;
  }
  return args;
}

async function loadCloses(args) {
  if (args.source === 'upbit') {
    return fetchUpbitCloses({ symbol: args.symbol, unit: 60, count: 200 });
  }
  // 워밍업(50) + 시뮬레이션 구간을 합쳐 생성
  return generateSyntheticCloses({ count: 50 + args.cycles, seed: args.seed });
}

async function main() {
  const args = parseArgs(process.argv);
  const { policy } = DEFAULT_CONFIG;
  const pf = createPortfolio({ cash: DEFAULT_CONFIG.startCash });
  const symbol = args.symbol;

  const closes = await loadCloses(args);
  const warmup = 50;
  let trades = 0;
  let protectiveExits = 0;
  const cyclesPerDay = policy.cyclesPerDay ?? 24;

  // 리서치 애널리스트(LLM)가 써둔 신호를 브리지 파일에서 읽어 의사결정에 반영.
  // 합성 시뮬레이션은 실시간 캘린더가 없으므로 TTL 검증을 끄고 전체 구간에 적용한다.
  let extraSignals = {};
  if (args.research) {
    const sig = loadResearchSignal(symbol, { enforceTtl: false });
    extraSignals = { research: sig.research, sentiment: sig.sentiment };
    const src = sig._source === 'file'
      ? `적용(score=${sig.research.score}, alert=${sig.sentiment.alert})`
      : `없음/무시(${sig._source}) → 중립`;
    console.log(`리서치 신호 : ${src}\n`);
  }

  for (let i = warmup; i < closes.length; i++) {
    const window = closes.slice(0, i + 1);
    const { order, riskReview, execution, protective } = runCycle(window, pf, { symbol, policy, mode: 'paper', ts: i, extraSignals });
    if (execution.status === 'filled' || execution.status === 'partial') {
      trades++;
      if (protective) protectiveExits++;
      const eq = equity(pf, { [symbol]: closes[i] });
      const tag = protective ? `보호청산:${protective}` : riskReview.decision;
      console.log(
        `#${String(i).padStart(3)} ${order.action.toUpperCase().padEnd(4)} ` +
          `size=${execution.filled.size} @${execution.filled.price} ` +
          `| cash=${Math.round(pf.cash)} equity=${Math.round(eq)} ` +
          `| ${tag}`,
      );
    }
    // 하루 경과 시 일일 손실 기준 리셋(킬 스위치가 실제 '일일' 기준으로 동작)
    if ((i - warmup + 1) % cyclesPerDay === 0) {
      rolloverDay(pf, { [symbol]: closes[i] });
    }
  }

  const lastPrice = closes[closes.length - 1];
  const finalEq = equity(pf, { [symbol]: lastPrice });
  const ret = ((finalEq / pf.startEquity - 1) * 100).toFixed(2);
  console.log('\n=== 페이퍼 트레이딩 결과 ===');
  console.log(`데이터원   : ${args.source}`);
  console.log(`종목       : ${symbol}`);
  console.log(`사이클     : ${closes.length - warmup}`);
  console.log(`체결 횟수  : ${trades} (보호 청산 ${protectiveExits}회)`);
  console.log(`시작 자산  : ${pf.startEquity.toLocaleString()} KRW`);
  console.log(`최종 자산  : ${Math.round(finalEq).toLocaleString()} KRW`);
  console.log(`실현손익   : ${Math.round(pf.realizedPnl).toLocaleString()} KRW`);
  console.log(`수익률     : ${ret}%`);
  console.log('\n* 모의 결과이며 미래 수익을 보장하지 않습니다.');
}

main().catch((err) => {
  console.error('[paper-trade] 오류:', err.message);
  process.exit(1);
});
