// 가격 데이터 공급원.
// - synthetic: 결정적 시드 기반 랜덤워크 캔들 (페이퍼 트레이딩/테스트용)
// - upbit: 실데이터 (egress 허용 + 키 필요. 막혀 있으면 친절한 에러)

// 간단한 시드 PRNG (mulberry32) → 재현 가능한 시뮬레이션
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 종가 시계열 생성. trend 는 사이클당 평균 드리프트(비율).
export function generateSyntheticCloses({ count = 200, start = 50_000_000, vol = 0.01, trend = 0.0005, seed = 42 } = {}) {
  const rand = mulberry32(seed);
  const closes = [start];
  for (let i = 1; i < count; i++) {
    const shock = (rand() - 0.5) * 2 * vol;
    const next = closes[i - 1] * (1 + trend + shock);
    closes.push(Math.max(1, next));
  }
  return closes;
}

// Upbit 실데이터 캔들. 실패(egress 차단/키 없음) 시 명확한 에러를 던진다.
export async function fetchUpbitCloses({ symbol = 'KRW-BTC', unit = 60, count = 200 } = {}) {
  const url = `https://api.upbit.com/v1/candles/minutes/${unit}?market=${symbol}&count=${count}`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new Error(
      `Upbit 연결 실패: ${err.message}\n` +
        `→ 원격 환경이라면 네트워크 송신 허용목록에 api.upbit.com 을 추가했는지 확인하세요.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Upbit 응답 오류 ${res.status}. (egress 허용목록/지역 제한 확인)`);
  }
  const data = await res.json();
  // Upbit 는 최신순 → 과거순으로 뒤집어 종가만 추출
  return data.reverse().map((c) => c.trade_price);
}
