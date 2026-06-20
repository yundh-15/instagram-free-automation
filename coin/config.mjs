// 코인 투자 에이전트 팀 - 공통 설정 및 리스크 정책
// 기본값은 보수적이며, 기본 모드는 페이퍼 트레이딩(모의)이다.

export const DEFAULT_POLICY = {
  baseCurrency: 'KRW',
  // 단일 종목 최대 비중 (자산 대비)
  maxPositionPct: 0.2,
  // 일일 최대 손실 한도 → 초과 시 신규 매수 차단(킬 스위치)
  dailyMaxLossPct: 0.05,
  // 손절(stop_loss) 미설정 주문은 거부
  requireStopLoss: true,
  // 매수 시 가정 슬리피지
  slippagePct: 0.0005,
  // 1회 매수가 사용할 수 있는 현금 비중 상한
  maxCashUsePct: 0.95,
  // 최소 주문 금액(KRW). 이하의 주문은 거부(마이크로 주문/먼지 체결 방지). Upbit 최소 5,000원.
  minOrderKRW: 5000,
  // '하루'로 간주할 사이클 수(예: 1시간봉 24개 = 1일). 이 주기마다 일일 손실 기준 리셋.
  cyclesPerDay: 24,
};

export const DEFAULT_CONFIG = {
  mode: 'paper', // 'paper' | 'live' (live 는 명시적으로만)
  startCash: 1_000_000, // KRW
  symbol: 'KRW-BTC',
  policy: DEFAULT_POLICY,
};
