// 포트폴리오 상태 영속화(파일 저장/로드). 클라우드 cron 간 연속 운용을 위해 사용.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPortfolio } from './portfolio.mjs';

// 상태 파일을 로드. 없으면 초기 포트폴리오 생성.
export function loadState(path, { startCash = 1_000_000 } = {}) {
  if (!existsSync(path)) {
    return { portfolio: createPortfolio({ cash: startCash }), meta: { createdAt: new Date().toISOString(), cycles: 0 } };
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    // 하위호환: 누락 필드 보정
    const pf = data.portfolio ?? createPortfolio({ cash: startCash });
    pf.positions ??= {};
    pf.history ??= [];
    return { portfolio: pf, meta: data.meta ?? { cycles: 0 } };
  } catch {
    // 손상 시 안전하게 초기화하지 않고 에러를 던져 사람이 확인하게 한다.
    throw new Error(`상태 파일 파싱 실패: ${path}. 수동 확인이 필요합니다.`);
  }
}

export function saveState(path, portfolio, meta = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const payload = { portfolio, meta: { ...meta, updatedAt: new Date().toISOString() } };
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n');
  return path;
}

// 사이클 결과를 append-only 로그(JSONL)에 추가.
export function appendRunLog(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  const prefix = existsSync(path) ? '' : '';
  writeFileSync(path, prefix + line + '\n', { flag: 'a' });
  return path;
}
