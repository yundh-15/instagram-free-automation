// 리서치 신호 브리지 (LLM ↔ 코드 루프 연결).
//
// 리서치 애널리스트(Claude 서브에이전트)가 분석 결과를 아래 경로의 JSON 으로 쓰면,
// 매매 루프가 이를 읽어 CIO 의 의사결정(extraSignals)에 반영한다.
//   기본 경로: data/coin-signals/research-<SYMBOL>.json
//
// 페일세이프: 파일이 없거나·깨졌거나·오래됐으면(neutral) 점수 0 으로 처리해
// 루프가 리서치 없이도 안전하게 돈다(없는 신호가 매매를 왜곡하지 않음).
import { readFileSync, existsSync } from 'node:fs';

const NEUTRAL = Object.freeze({
  research: { score: 0 },
  sentiment: { score: 0, alert: false },
});

function clamp(x, lo = -1, hi = 1) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

// 반환: { research:{score}, sentiment:{score,alert}, _source, raw? }
export function loadResearchSignal(symbol, { dir = 'data/coin-signals', now = Date.now(), enforceTtl = true } = {}) {
  const path = `${dir}/research-${symbol}.json`;
  if (!existsSync(path)) return { ...NEUTRAL, _source: 'missing', path };

  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ...NEUTRAL, _source: 'parse-error', path };
  }

  // 신선도(TTL) 검증: 오래된 리서치는 무시
  if (enforceTtl && data.ts && data.ttl_minutes) {
    const ageMin = (now - new Date(data.ts).getTime()) / 60000;
    if (!Number.isFinite(ageMin) || ageMin > data.ttl_minutes) {
      return { ...NEUTRAL, _source: 'stale', path, ageMin };
    }
  }

  const sentiment = data.sentiment || {};
  return {
    research: { score: clamp(data.score) },
    sentiment: { score: clamp(sentiment.score), alert: Boolean(sentiment.alert) },
    _source: 'file',
    path,
    raw: data,
  };
}
