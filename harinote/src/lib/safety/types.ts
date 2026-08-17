/**
 * [계약 파일] 안전 점수 모델 타입 정의
 * SafetyScore = 100 - (Weather + Disaster + Medical)
 * 변경 시 데이터/점수엔진/UI 전 영역에 영향 — 수정은 메인 세션 승인 후에만.
 */

/**
 * 동행 프로필 — 위험 가중치 차등 적용.
 * 아이·부모님은 동시 선택 가능 (with_kids_seniors) — 폭염 임계 하향은 둘 다,
 * 미세먼지 민감군은 아이, 응급의료 가중은 부모님이 각각 적용된다.
 * (이동수단(자차/대중교통)은 점수 축이 아니라 추천 반경에만 영향 — travel-condition.ts)
 */
export type Profile =
  | "default"
  | "with_kids"
  | "with_seniors"
  | "with_kids_seniors";

export const PROFILE_LABEL: Record<Profile, string> = {
  default: "기본",
  with_kids: "아이 동반",
  with_seniors: "부모님 동반",
  with_kids_seniors: "아이·부모님 동반",
};

/** 관광지 1곳의 위험 계산 입력값 — 공공데이터에서 채워짐 (1주차: fixture) */
export interface RiskInput {
  /** 최고기온 ℃ (기상청 단기예보) */
  tempC: number;
  /** 일 최대 체감온도 ℃ (기상청 여름철 산식) — 없으면 tempC로 폭염 평가 (계절 모드·mock 경로) */
  apparentTempC?: number;
  /**
   * 일 최저기온 ℃ — 한파 축(weights.ts COLD) 입력. 없으면 축 비활성(감점 0).
   *
   * tempC(최고기온)와 별개 값이라 이중 계상이 아니다 — 쾌적층 TCI는 낮 관광 쾌적을
   * tempC로 보고, 한파 축은 기상청 한파특보와 같은 아침 최저기온으로 위험을 본다.
   * (강수를 쾌적 TCI와 안전층 호우로 나눠 보는 것과 같은 층 분리)
   */
  tminC?: number;
  /** 강수확률 % */
  rainProbPct: number;
  /** 예상 강수량 mm (선택) */
  rainMm?: number;
  /** 풍속 m/s — 중기예보(D+4~)는 미제공. 없으면 TCI 풍속 축 제외 후 재정규화 */
  windMs?: number;
  /** 일조시간 대용(h) — 하늘상태(SKY) 환산. TCI 일조 축. 없으면 4축 재정규화 */
  sunHours?: number;
  /** 초미세먼지 PM2.5 ㎍/㎥ (AirKorea) */
  pm25: number;
  /** 산불위험 단계 1~4 (산림청: 1 낮음 ~ 4 심각) */
  forestFireLevel: 1 | 2 | 3 | 4;
  /**
   * 산사태 예보발령 0~2 (0 없음 / 1 주의보 / 2 경보 — 산림청 산사태정보시스템).
   * 미제공(undefined)이면 발령 없음(감점 0)과 같게 계산된다 — 자체 추정은 하지 않는다.
   */
  landslideLevel?: 0 | 1 | 2;
  /** 최근접 응급의료기관까지 거리 km (보건복지부) */
  emergencyRoomKm: number;
}

export type RiskFactorKey =
  | "heat" // 폭염
  | "cold" // 한파 (RiskInput.tminC가 있을 때 — 예보 경로·계절 모드 공통)
  | "rain" // 강수 (관광기후지수 강수 축, 쾌적)
  | "wind" // 바람 (관광기후지수 풍속 축, 쾌적)
  | "sun" // 일조 (하늘상태 SKY 환산 — TCI 일조 축)
  | "pm" // 미세먼지
  | "heavy_rain" // 호우 침수·급류 (기상청 호우 특보 severity, 안전층)
  | "forest_fire" // 산불
  | "landslide" // 산사태 (산림청 예보발령)
  | "medical"; // 응급의료 접근성

export type RiskLevel = "low" | "moderate" | "high";

/** 위험 요인 1건 — RiskBreakdownBar가 그대로 렌더링하는 단위 */
export interface RiskFactor {
  key: RiskFactorKey;
  /** 표시명: "폭염", "강수·강풍" 등 */
  label: string;
  /** 관측/예보값 (예: 34.2) */
  value: number;
  /** 값 단위 표시 (예: "℃", "%", "㎍/㎥", "단계", "km") */
  unit: string;
  /** 공식 임계값 (예: 폭염주의보 33) */
  threshold: number;
  /** 감점 (프로필 가중 적용 후, 반올림) */
  points: number;
  /** 이 요인의 감점 상한 */
  maxPoints: number;
  level: RiskLevel;
  /** 사용자용 설명: "최고기온 34.2℃ — 폭염주의보 기준(33℃) 초과" */
  description: string;
}

/** 안전 점수 계산 결과 — UI·DB(safety_snapshots.factors) 공용 계약 */
export interface RiskBreakdown {
  /** 0~100. 높을수록 주의 요인 낮음 */
  score: number;
  /**
   * 등급 표현 주의: "안전합니다" 금지.
   * low = "방문 주의 요인 낮음", moderate = "주의 요인 있음", high = "주의 요인 높음"
   */
  grade: RiskLevel;
  profile: Profile;
  factors: RiskFactor[];
  /**
   * 제안서 산식의 카테고리 소계 (감점 원값 합).
   * 총 감점이 100을 넘는 극단 입력에서는 score가 0으로 고정되어
   * 소계 합이 (100 - score)를 초과할 수 있다.
   */
  weatherRisk: number;
  disasterRisk: number;
  medicalRisk: number;
}

/**
 * 쾌적층에 속하는 요인 — 나머지는 전부 안전층으로 본다.
 *
 * 왜 나누나: 같은 감점이라도 "비가 와서 관광이 불편함"과 "산불 단계가 높아 위험함"은
 * **코스 추천에서 뜻이 다르다.** 총점으로 거르면 12월엔 추위만으로 야외 후보가 전멸한다
 * (lib/safety/layers.ts meetsCourseSafety 참고 — 실측 758곳 → 0곳).
 *
 * 한파(cold)는 안전층이다 — 기상 현상이지만 판단 기준이 기상청 한파특보(위험)이지
 * 관광 쾌적이 아니다. 반대로 강수(rain)는 관광기후지수의 쾌적 축이고, 같은 비라도
 * 침수·급류 위험은 heavy_rain으로 따로 잡힌다.
 *
 * ⚠ **화면에는 이 구분을 쓰지 않는다.** 쾌적함 부족도 결국 관광의 완성도를 떨어뜨리는
 *   리스크라 총점에서 같이 깎이는데, 표시까지 둘로 나누면 "점수가 두 개"로 읽힌다.
 *   사용자에게 보이는 것은 총점 하나와 요인별 내역(RiskBreakdownBar)뿐이다.
 *
 * ⚠ breakdown의 weatherRisk/disasterRisk/medicalRisk 필드는 추천 로직이 쓰므로
 *   (예: alternatives.ts 악천후 실내 우대) 이 분류와 별개다.
 *   그쪽은 제안서 산식의 3분류를 그대로 유지한다.
 */
export const COMFORT_FACTOR_KEYS: readonly RiskFactorKey[] = [
  "heat",
  "rain",
  "wind",
  "pm",
  "sun",
];

export const GRADE_LABEL: Record<RiskLevel, string> = {
  low: "방문 주의 요인 낮음",
  moderate: "주의 요인 있음",
  high: "주의 요인 높음",
};

/** 1주차 mock 시나리오 키 — fixtures/safety/risk-inputs.ts가 구현 */
export type ScenarioKey = "clear" | "heatwave" | "rainy" | "bad_air";
