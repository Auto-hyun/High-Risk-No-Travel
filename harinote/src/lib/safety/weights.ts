/**
 * 안전 점수 가중치·임계값 상수 — 이 파일이 값의 단일 출처다.
 *
 * 현행 산식: SafetyScore = 100 − (쾌적층 TCI 감점 + 안전층 감점)
 *   · 쾌적층 = 체감온도·강수·미세먼지·바람·일조. **가중치는 tci.ts TCI_WEIGHTS**에 있다
 *     (한국형 관광기후지수 KTCI 실증가중). 이 파일의 HEAT/RAIN_WIND/PM25 상수와
 *     *Points() 함수들은 그 이전 세대(v1)의 것으로, 현재 점수 계산에 쓰이지 않는다 —
 *     남아 있는 이유는 각 함수 주석 참조.
 *   · 안전층 = 호우·산불·산사태·응급의료. 값은 전부 이 파일에 있다.
 *
 * **근거의 등급을 값마다 표시한다** — ✅ 공공기준/자체실증 · 🟡 외부논문 인용 ·
 * ❌ 설계값(민감도 분석으로 강건성 방어).
 *   · 전체 지도: analysis/25_safety_evidence_map.md ← 값을 추가·변경하면 여기도 갱신할 것
 *   · 강건성 실측: analysis/24_safety_sensitivity_result.md (`pnpm check:sensitivity`)
 *
 * 주의: 이 파일 밖에 임계값을 두지 말 것(프로젝트 규칙). 표시 상한처럼 계산 구조에
 * 종속된 값만 score.ts/tci.ts가 파생한다.
 */
import type { Profile, RiskLevel } from "@/lib/safety/types";
import type { PlaceEnvType } from "@/lib/tour/types";
// 타입만 가져온다 — 쾌적층 가중의 소유자는 tci.ts다(이 파일 헤더 참조)
import type { TciWeights } from "@/lib/safety/tci";

// ─────────────────────────────────────────────
// 폭염 (상한 25)
// ─────────────────────────────────────────────
// 입력은 체감온도(apparentTempC) 우선 — score.ts의 heatEvalC 참조
export const HEAT = {
  /** 기상청 폭염주의보 발표 기준: 일 최고 체감온도 33℃ 이상 지속 예상 */
  ADVISORY_C: 33,
  /** 기상청 폭염경보 발표 기준: 일 최고 체감온도 35℃ 이상 지속 예상 */
  WARNING_C: 35,
  /** 33℃ 미만 저감점 구간의 시작(28℃부터 완만히 상승) */
  RAMP_START_C: 28,
  MAX_POINTS: 25,
} as const;

/**
 * 최고기온(℃) → 폭염 기본 감점. 주의보(33℃)에서 중간, 경보(35℃)부터 상한 근접.
 * shiftC(민감층 임계값 하향): 기상청 폭염 영향예보가 취약계층(어린이·노약자)을
 * 일반인보다 낮은 체감온도에서 위험 단계에 진입시키는 구조를 차용 —
 * 곡선 전체를 shiftC만큼 왼쪽으로 이동시킨다 (= tempC + shiftC 지점에서 평가).
 *
 * ⚠ **현행 엔진은 이 함수를 호출하지 않는다** — 폭염은 tci.ts thermalScore로 계산된다.
 *   NOTE_민감층_임계값.md가 "2℃ 좌측 이동"을 채택했을 때 전제한 곡선이 이것이라,
 *   그 근거가 현행 곡선에서도 성립하는지 대조하는 기준으로 남겨 둔다.
 */
export function heatPoints(tempC: number, shiftC = 0): number {
  const t = tempC + shiftC;
  if (t < HEAT.RAMP_START_C) return 0;
  if (t < HEAT.ADVISORY_C) {
    // 28~33℃: 0 → 8점 완만 상승 (저감점)
    return ((t - HEAT.RAMP_START_C) / (HEAT.ADVISORY_C - HEAT.RAMP_START_C)) * 8;
  }
  if (t < HEAT.WARNING_C) {
    // 폭염주의보 구간 33~35℃: 12 → 22점
    return 12 + (t - HEAT.ADVISORY_C) * 5;
  }
  // 폭염경보 35℃+: 22점에서 시작해 상한 25점까지
  return Math.min(HEAT.MAX_POINTS, 22 + (t - HEAT.WARNING_C) * 1.5);
}

// ─────────────────────────────────────────────
// 강수·강풍 (합산 상한 20)
// ─────────────────────────────────────────────
export const RAIN_WIND = {
  /** 기상청 단기예보 강수확률 구간: 30% 이상부터 '비 가능성' 안내 통용 */
  PROB_LOW_PCT: 30,
  PROB_MID_PCT: 60,
  PROB_HIGH_PCT: 80,
  /** 기상청 호우주의보 발표 기준: 3시간 강수량 60mm 이상 예상 */
  HEAVY_RAIN_MM: 60,
  /** 호우주의보의 절반 수준 — 우산·우비 필수 구간으로 가점 */
  MODERATE_RAIN_MM: 30,
  /** 기상청 강풍주의보 발표 기준: 육상 풍속 14m/s 이상 예상 */
  WIND_ADVISORY_MS: 14,
  /** 강풍주의보 미만이지만 체감 위험이 커지는 풍속(주의보 기준의 약 2/3) */
  WIND_CAUTION_MS: 9,
  MAX_POINTS: 20,
} as const;

/**
 * 강수확률(%) + 예상 강수량(mm) → 강수 기본 감점 (0~18).
 * ⚠ 현행 엔진 미사용(v1) — 강수는 tci.ts rainScore, 침수·급류는 위 HEAVY_RAIN이 맡는다.
 *   RAIN_WIND 상수 자체는 report/checklist.ts가 준비물 문구 기준으로 계속 쓴다.
 */
export function rainPoints(rainProbPct: number, rainMm?: number): number {
  let pts = 0;
  if (rainProbPct >= RAIN_WIND.PROB_HIGH_PCT) pts = 12;
  else if (rainProbPct >= RAIN_WIND.PROB_MID_PCT) pts = 8;
  else if (rainProbPct >= RAIN_WIND.PROB_LOW_PCT) pts = 4;
  if (rainMm !== undefined) {
    if (rainMm >= RAIN_WIND.HEAVY_RAIN_MM) pts += 6;
    else if (rainMm >= RAIN_WIND.MODERATE_RAIN_MM) pts += 3;
  }
  return pts;
}

/** 풍속(m/s) → 강풍 기본 감점 (0~8). ⚠ 현행 엔진 미사용(v1) — tci.ts windScore가 대체. */
export function windPoints(windMs: number): number {
  if (windMs >= RAIN_WIND.WIND_ADVISORY_MS) return 8;
  if (windMs >= RAIN_WIND.WIND_CAUTION_MS) return 4;
  return 0;
}

// ─────────────────────────────────────────────
// 한파 (상한 25) — 현재 계절 모드(D+4~)에서만 적용된다
// ─────────────────────────────────────────────
/**
 * 한파 감점 임계값.
 * 기준: 기상청 한파주의보 −12℃ / 한파경보 −15℃ (아침 최저기온).
 *   폭염 커브와 대칭 형태로 두어 더위·추위의 감점 스케일을 맞춘다.
 *
 * 적용: RiskInput.tminC가 있으면 점수 엔진(score.ts)이 계산한다 — 예보 경로는
 *   기상청 TMN, 계절 모드는 30년 시나리오의 최저기온이 입력이다. tminC를 주지
 *   않는 경로(mock)는 축이 비활성이다. 후처리가 아니라 축이라 경로가 늘어도
 *   빠뜨리지 않는다.
 *
 * ⚠ 한계: 오늘을 오후에 조회하면 아침 최저(TMN)가 이미 예보에서 빠져 남은
 *   시간대 TMP 최솟값으로 대체된다 — kma.ts tminC 주석 참조.
 */
export const COLD = {
  ADVISORY_C: -12,
  WARNING_C: -15,
  /** 감점이 시작되는 온도 — 이보다 따뜻하면 0 */
  RAMP_START_C: -5,
  MAX_POINTS: 25,
} as const;

/** 최저기온(℃) → 한파 기본 감점 (analysis/16b cold_points와 동일 곡선) */
export function coldPoints(tempC: number): number {
  if (tempC > COLD.RAMP_START_C) return 0;
  if (tempC > COLD.ADVISORY_C) return ((COLD.RAMP_START_C - tempC) / 7) * 8;
  if (tempC > COLD.WARNING_C) return 12 + (COLD.ADVISORY_C - tempC) * (10 / 3);
  return Math.min(COLD.MAX_POINTS, 22 + (COLD.WARNING_C - tempC) * 1.5);
}

// ─────────────────────────────────────────────
// 미세먼지 (상한 15)
// ─────────────────────────────────────────────
/** 환경부 초미세먼지(PM2.5) 예보 등급 기준(㎍/㎥): 좋음 0~15, 보통 16~35, 나쁨 36~75, 매우나쁨 76+ */
export const PM25 = {
  GOOD_MAX: 15,
  MODERATE_MAX: 35,
  BAD_MAX: 75,
  MAX_POINTS: 15,
} as const;

export const PM25_GRADE_LABEL = {
  good: "좋음",
  moderate: "보통",
  bad: "나쁨",
  very_bad: "매우나쁨",
} as const;

/**
 * PM2.5(㎍/㎥) → 미세먼지 기본 감점.
 * sensitive(민감군 곡선): EPA AQI의 "민감군에게 나쁨(USG)" 구조 차용 —
 * 같은 농도에서 민감군(아이 동반)은 한 단계 이른 감점 (보통 3→5, 나쁨 8→12).
 *
 * ⚠ **현행 엔진 미사용(v1)** — 미세먼지 점수는 tci.ts pmScore가 계산한다.
 *   NOTE_민감층_임계값.md가 채택한 민감군 곡선(보통 3→5, 나쁨 8→12)의 원본이 이 함수이고,
 *   그 취지는 pmScore(pm25, sensitive)로 이식됐다. 이식 시 밴드 비를 어떻게 옮겼는지는
 *   pmScore 주석 참조. 이 구현은 채택 스펙의 원문 대조용으로 남긴다.
 */
export function pmPoints(pm25: number, sensitive = false): number {
  if (pm25 <= PM25.GOOD_MAX) return 0;
  if (pm25 <= PM25.MODERATE_MAX) return sensitive ? 5 : 3;
  if (pm25 <= PM25.BAD_MAX) return sensitive ? 12 : 8;
  return PM25.MAX_POINTS;
}

export function pmGradeLabel(pm25: number): string {
  if (pm25 <= PM25.GOOD_MAX) return PM25_GRADE_LABEL.good;
  if (pm25 <= PM25.MODERATE_MAX) return PM25_GRADE_LABEL.moderate;
  if (pm25 <= PM25.BAD_MAX) return PM25_GRADE_LABEL.bad;
  return PM25_GRADE_LABEL.very_bad;
}

// ─────────────────────────────────────────────
// 산불 — 단계를 여행 권고 등급에 앵커 (100점 만점 기준이라 감점 자체가 등급 보장)
//   낮음 0 / 다소높음 15(밴드) / 높음 45→총점 ≤55(주의) / 심각(매우높음) 80→≤20(방문자제)
//   근거: 단계=산림청 4단계(공식) · 순서=발생확률 실증(낮음2.06<다소높음9.70<높음15.37<
//   매우높음27.41%, 한국산림과학회지 2025) · 절대값=등급컷 앵커(밴드값은 민감도 분석으로 방어)
// ─────────────────────────────────────────────
/** 산림청 산불위험예보 4단계: 1 낮음, 2 다소높음, 3 높음, 4 매우높음 */
export const FOREST_FIRE = {
  LEVEL_LABEL: { 1: "낮음", 2: "다소높음", 3: "높음", 4: "매우높음" } as Record<
    1 | 2 | 3 | 4,
    string
  >,
  /** 단계별 감점 — 높음(45)·매우높음(80)은 주의·방문자제 등급에 도달하게 앵커 */
  POINTS_BY_LEVEL: { 1: 0, 2: 15, 3: 45, 4: 80 } as Record<1 | 2 | 3 | 4, number>,
  MAX_POINTS: 80,
} as const;

/** 외부 API 이상치(0, 5 등) 유입 시 NaN 전파 방지 — 1~4로 clamp */
export function normalizeForestFireLevel(level: number): 1 | 2 | 3 | 4 {
  const n = Math.round(level);
  return (n < 1 ? 1 : n > 4 ? 4 : n) as 1 | 2 | 3 | 4;
}

export function forestFirePoints(level: number): number {
  return FOREST_FIRE.POINTS_BY_LEVEL[normalizeForestFireLevel(level)];
}

// ─────────────────────────────────────────────
// 산사태 (Disaster, 상한 80 — 경보를 방문자제 등급에 앵커) — 산림청 공식 예보발령만 사용
// ─────────────────────────────────────────────
/**
 * 산사태 위험 0~2 (0 발령 없음 / 1 주의보 / 2 경보).
 * 근거: 산림청 산사태정보시스템 예보발령은 토양함수지수(누적 강우로 산정한 토양 속
 *   빗물량)로 발령한다 — 권역 토양함수지수 80% 도달 시 주의보, 100% 시 경보.
 *   실시간 예보발령 API(data.go.kr/15074798)를 15분 캐시로 조회하고(risk/landslide.ts),
 *   발령이 있는 시군만 감점한다. 자체 추정(강수량×지형 프록시)은 쓰지 않는다 —
 *   발령 권한이 있는 기관의 판단만 산사태 축의 근거로 삼는다는 결정(2026-08).
 *   발령은 시군 단위이므로 같은 시군의 관광지는 실내·야외 구분 없이 같은 단계를 받는다.
 *   산불(건조)과 산사태(강우)는 상반된 기상 조건에서 발생 → 동시에 높기 어렵다.
 */
export const LANDSLIDE = {
  LEVEL_LABEL: { 0: "없음", 1: "주의보", 2: "경보" } as Record<0 | 1 | 2, string>,
  /** 단계별 감점 — 발령을 여행 권고 등급에 앵커: 주의보 45→총점 ≤55(주의), 경보 80→≤20(방문자제) */
  POINTS_BY_LEVEL: { 0: 0, 1: 45, 2: 80 } as Record<0 | 1 | 2, number>,
  MAX_POINTS: 80,
} as const;

/** 외부값(음수·3 등) 유입 시 0~2로 clamp */
export function normalizeLandslideLevel(level: number): 0 | 1 | 2 {
  const n = Math.round(level);
  return (n < 0 ? 0 : n > 2 ? 2 : n) as 0 | 1 | 2;
}

/**
 * 감점에 쓰는 실효 단계 — 실내 시설은 발령 단계를 한 단계 완화한다
 * (주의보 → 감점 없음, 경보 → 주의보 밴드 45점).
 * 근거: 발령은 시군 단위라 도심 상가 음식점도 그대로 맞으면 산지와 같은 감점을 받는다.
 *   산사태 피해는 사면에 인접한 야외 활동에 집중되므로 실내는 한 단계 낮춰 본다.
 *   다만 경보는 주민 대피 단계라 0으로 면제하지 않는다(주의 등급에는 남는다).
 * 다른 축(기상·산불)이 쓰는 실내 할인 ×0.3 대신 이산 규칙을 쓰는 이유:
 *   산사태 밴드(45/80)가 커서 배율의 ±20% 교란이 실내 셀의 등급을 뒤집는다
 *   (실측 등급 유지율 84.2% < 게이트 85%, analysis/24). 이산 규칙은 그 흔들림이 없다.
 */
export function landslideEffectiveLevel(
  level: 0 | 1 | 2,
  envType: PlaceEnvType,
): 0 | 1 | 2 {
  if (envType !== "indoor" || level === 0) return level;
  return (level - 1) as 0 | 1;
}

export function landslidePoints(level: number): number {
  return LANDSLIDE.POINTS_BY_LEVEL[normalizeLandslideLevel(level)];
}

// ─────────────────────────────────────────────
// 호우 침수·급류 (안전층, 상한 20) — 쾌적층 강수(TCI)와 분리된 위험 축
// ─────────────────────────────────────────────
/**
 * 일 강수량 → 침수·급류 위험 감점.
 * 밴드 경계: 기상청 호우 특보 발표 기준(주의보 3시간 60mm, 경보 3시간 90mm)을
 *   일강수로 근사하고, 그 아래 예비 구간을 주의보의 절반(30mm)으로 둔다.
 *   쾌적층 TCI 강수는 5mm에서 포화하므로(= 관광 불편의 상한), 그 위의 "위험" 구간을
 *   이 축이 맡는다. 강수가 두 번 깎이는 게 아니라 층이 다르다.
 * 절대값(6/11/16)은 설계값 — 안전층 표시 상한 20 안에서 밴드를 배분한 것이며
 *   공공 기준이 아니다. 강건성은 민감도 분석으로 확인한다
 *   (analysis/24_safety_sensitivity.md, 재현: pnpm check:sensitivity).
 */
/**
 * 일조 감점 완화 계수 — 강수확률이 높으면 "흐림"은 강수 축이 이미 반영하므로
 * 일조에서 또 깎지 않는다(이중 페널티 방지). 밴드는 강수 밴드(30/60%)와 맞춘다.
 * 강수확률이 결측이면 정보가 없는 것이므로 완화하지 않는다(계수 1).
 */
export const SUN_RAIN_ADJ = {
  HIGH_PROB_PCT: 60,
  MID_PROB_PCT: 30,
  /** 강수확률 60%↑ 완전 상쇄 / 30~60% 절반 / 그 미만 그대로 */
  FACTORS: { high: 0, mid: 0.5, low: 1 },
} as const;

export const HEAVY_RAIN = {
  /** 호우주의보의 절반 — 우산·우비 필수를 넘어 침수가 시작되는 구간 */
  PRE_MM: 30,
  /** 기상청 호우주의보: 3시간 60mm 이상 예상 */
  WATCH_MM: 60,
  /** 기상청 호우경보: 3시간 90mm 이상 예상 */
  WARN_MM: 90,
  POINTS: { pre: 6, watch: 11, warn: 16 },
  MAX_POINTS: 20,
} as const;

/** 일강수량(mm) → 호우 기본 감점. 결측이면 0(정보 없음이 불이익이 되지 않게). */
export function heavyRainPoints(
  rainMm: number | undefined,
  points: { pre: number; watch: number; warn: number } = HEAVY_RAIN.POINTS,
): number {
  if (rainMm === undefined) return 0;
  if (rainMm >= HEAVY_RAIN.WARN_MM) return points.warn;
  if (rainMm >= HEAVY_RAIN.WATCH_MM) return points.watch;
  if (rainMm >= HEAVY_RAIN.PRE_MM) return points.pre;
  return 0;
}

// ─────────────────────────────────────────────
// 응급의료 접근성 (상한 10)
// ─────────────────────────────────────────────
/**
 * 중증 응급환자 골든타임 확보 기준 거리.
 * 기준: 보건복지부 응급의료 취약지 판정(지역응급의료센터 30분 내 접근).
 *
 * 거리 경계는 가정 환산이 아니라 실측 대응이 확인됐다 — 강원 119 출동 기록의
 * 거리↔소요시간 중앙값 회귀(analysis/11_medical_curve.py, 재현 시 재계산):
 *   소요분 = 8.32 + 0.53 × 도로거리km   (직선거리는 우회계수 1.3 적용)
 * 이 식으로 현행 경계는 10km→15분 / 20km→22분 / 30km→29분에 대응한다.
 * 즉 상한(30km)이 복지부 30분 기준에 맞고, 그 아래 두 구간이 그 안을 나눈다.
 *
 * 한계(정직하게): 위 회귀는 소방서→현장 출동 구간이라 관광지→병원 이송 구간에
 * 그대로 적용한 근사다. 취약지의 다른 축인 60분 기준까지 선형 외삽하면 75km가
 * 나오는데, 함축 속도가 114km/h라 강원 산악도로에서 비현실적이므로 채택하지 않았다.
 */
export const MEDICAL = {
  NEAR_KM: 10,
  MID_KM: 20,
  FAR_KM: 30,
  MAX_POINTS: 10,
} as const;

/** 최근접 응급의료기관 거리(km) → 기본 감점 */
export function medicalPoints(km: number): number {
  if (km >= MEDICAL.FAR_KM) return MEDICAL.MAX_POINTS;
  if (km > MEDICAL.MID_KM) {
    // 20~30km: 5 → 10점
    return 5 + ((km - MEDICAL.MID_KM) / (MEDICAL.FAR_KM - MEDICAL.MID_KM)) * 5;
  }
  if (km > MEDICAL.NEAR_KM) {
    // 10~20km: 2 → 5점
    return 2 + ((km - MEDICAL.NEAR_KM) / (MEDICAL.MID_KM - MEDICAL.NEAR_KM)) * 3;
  }
  // 10km 이내: 0 → 2점 (소량)
  return (km / MEDICAL.NEAR_KM) * 2;
}

// ─────────────────────────────────────────────
// 환경 유형 가중 — TourAPI 카테고리 기반 자체 분류(PlaceEnvType)를 점수에 반영
// ─────────────────────────────────────────────
export interface EnvWeight {
  heat: number;
  rain: number;
  wind: number;
  pm: number;
  fire: number;
}

// fire는 산불 1~3단계에만, 그중에서도 할인(<1)만 적용된다 (적용 지점: score.ts fireEnv).
//  - 4단계(매우높음)는 입산통제·대피급이라 지형 무관하게 방문자제 밴드에 남긴다
//  - 산악 가중 1.3은 설계값이라 실증 보정 전까지 미적용 — 적용 시 산불 3단계에서
//    산악 관광지 216곳이 일괄 방문자제가 되는데 그 배율의 근거가 아직 없다
// 산사태는 배율이 아니라 이산 규칙(실내 한 단계 완화)을 쓴다 — landslideEffectiveLevel 참조.
export const ENV_WEIGHT: Record<PlaceEnvType, EnvWeight> = {
  /** 실내는 기상 영향이 낮다. 산불도 직접 노출이 낮아 동일하게 0.3 —
   * 도심 상가 음식점이 시군 산불 단계를 그대로 감점받는 왜곡 방지 */
  indoor: { heat: 0.3, rain: 0.3, wind: 0.3, pm: 0.3, fire: 0.3 },
  /** 계곡·수변: 호우 시 급류·불어남 위험 */
  outdoor_water: { heat: 1.0, rain: 1.5, wind: 1.0, pm: 1.0, fire: 1.0 },
  /** 산악: 강풍·산불 위험 가중 */
  outdoor_mountain: { heat: 1.0, rain: 1.0, wind: 1.3, pm: 1.0, fire: 1.3 },
  /** 해안: 강풍 위험 가중 */
  outdoor_coast: { heat: 1.0, rain: 1.0, wind: 1.5, pm: 1.0, fire: 1.0 },
  outdoor_general: { heat: 1.0, rain: 1.0, wind: 1.0, pm: 1.0, fire: 1.0 },
};

// ─────────────────────────────────────────────
// 프로필 가중 (제안서 약속)
//
// 민감층(아이·부모님)의 기상 민감도는 배율(×1.3) 대신 "임계값 하향"으로 반영한다.
// 근거: 표준 위험지수들이 모두 이 구조를 쓴다 —
//  · 기상청 폭염 영향예보: 취약계층(어린이·노약자)은 일반인(주의보 33℃)보다 낮은
//    체감온도(31℃)부터 위험 단계 진입
//  · 미국 NWS HeatRisk: 민감군은 낮은 단계(Level 1~2)에서 먼저 영향
//  · 미국 EPA AQI: 101~150 = "민감군에게 나쁨(USG)" 전용 구간
// 배율 방식은 감점이 0인 온화한 날에 프로필 간 차이가 전혀 없다는 결함이 있었다.
// ─────────────────────────────────────────────
export interface ProfileWeight {
  heat: number;
  pm: number;
  medical: number;
  /** 폭염 임계값 하향 ℃ (민감층 2℃ — 영향예보 취약계층 관심단계 31℃ 근거) */
  heatShiftC: number;
  /** 미세먼지 민감군 곡선 사용 여부 (AQI USG 구조) */
  pmSensitive: boolean;
}

/**
 * 민감층 폭염 임계값 하향(heatShiftC)을 적용하기 시작하는 체감온도.
 *
 * 하향은 '더위' 쪽에만 걸어야 한다. 열쾌적 곡선 전체를 왼쪽으로 옮기면 추운 날에는
 * 더 따뜻한 지점에서 평가되어 **감점이 줄고**, 결과적으로 "아이 동반이 더 안전"해지는
 * 역전이 생긴다(겨울 계획 진단에서 실제로 관측됨). 최적 구간(18~25℃) 상단인 25℃를
 * 경계로 두어, 쾌적한 날에는 프로필 간 차이를 만들지 않고 더위부터 갈라지게 한다.
 */
export const HEAT_SHIFT_FLOOR_C = 25;

export const PROFILE_WEIGHT: Record<Profile, ProfileWeight> = {
  default: { heat: 1.0, pm: 1.0, medical: 1.0, heatShiftC: 0, pmSensitive: false },
  /** 아이 동반: 폭염 임계값 2℃ 하향 + 미세먼지 민감군 곡선 */
  with_kids: { heat: 1.0, pm: 1.0, medical: 1.0, heatShiftC: 2, pmSensitive: true },
  /** 부모님 동반: 응급의료 ×1.5 + 폭염 임계값 2℃ 하향 (노약자도 폭염 취약계층) */
  with_seniors: { heat: 1.0, pm: 1.0, medical: 1.5, heatShiftC: 2, pmSensitive: false },
  /** 아이·부모님 동시: 폭염 하향 + 미세먼지 민감(아이) + 응급의료 ×1.5(부모님) */
  with_kids_seniors: { heat: 1.0, pm: 1.0, medical: 1.5, heatShiftC: 2, pmSensitive: true },
};

// ─────────────────────────────────────────────
// 등급/레벨 컷
// ─────────────────────────────────────────────
/**
 * 점수 등급 컷: 70 이상 low(주의 요인 낮음), 40~69 moderate, 40 미만 high.
 * 설계값 — 안전층 밴드(산불 '높음' 45, 경보급 80)를 이 컷에 앵커해 단계가 곧 권고가 되게 했다.
 * 강건성은 민감도 분석으로 확인한다(analysis/24_safety_sensitivity_result.md).
 */
export const GRADE_CUT = { LOW: 70, MODERATE: 40 } as const;

export function gradeForScore(score: number): RiskLevel {
  if (score >= GRADE_CUT.LOW) return "low";
  if (score >= GRADE_CUT.MODERATE) return "moderate";
  return "high";
}

/**
 * 등급별 점수 구간 — 등급 안에서 점수로 색을 펴는 곳(지도 choropleth)이 참조한다.
 * GRADE_CUT에서 파생하므로 컷을 바꾸면 자동으로 따라온다(수동 복제 금지).
 */
export const GRADE_SCORE_RANGE: Record<RiskLevel, [number, number]> = {
  low: [GRADE_CUT.LOW, 100],
  moderate: [GRADE_CUT.MODERATE, GRADE_CUT.LOW],
  high: [0, GRADE_CUT.MODERATE],
};

/** 요인 레벨: 감점/상한 비율 1/3 미만 low, 2/3 미만 moderate, 이상 high */
export function levelForPoints(points: number, maxPoints: number): RiskLevel {
  const ratio = maxPoints > 0 ? points / maxPoints : 0;
  if (ratio < 1 / 3) return "low";
  if (ratio < 2 / 3) return "moderate";
  return "high";
}

// ─────────────────────────────────────────────
// 대체지 추천(reco) 임계값 — 안전점수에 거는 기준이므로 이 파일에서 관리
// ─────────────────────────────────────────────
/**
 * 의미 있는 개선으로 인정하는 최소 점수 차.
 * 근거: 반올림 오차(±1점)와 뚜렷이 구분되고, 등급 컷 간격(30점)의 1/6 수준 —
 * "체감되는 개선"의 설계값 (공공 기준 아님, 사용자 피드백으로 보정 예정).
 */
export const RECO_MIN_SCORE_GAIN = 5;

/**
 * '악천후'로 판단해 실내 후보를 우대하는 기상 감점 기준.
 * 근거: 기상 감점 상한 60점(폭염25+강수강풍20+미세먼지15)의 1/4 —
 * 특보 1개 초과분에 상당하는 설계값.
 */
export const RECO_WEATHER_RISK_INDOOR_THRESHOLD = 15;

// ─────────────────────────────────────────────
// 반나절 코스(course)·체크리스트(report) 임계값 — 안전점수에 거는 기준이므로 이 파일에서 관리
// ─────────────────────────────────────────────
/**
 * 코스에 포함하는 최소 안전점수.
 * 근거: 등급 컷 moderate 하한(40)과 low 하한(70)의 중간 — "주의 요인이 뚜렷하지 않은
 * 수준"의 설계값. 코스는 안내가 아니라 권유이므로 등급 low보다 완화된 컷 적용.
 */
export const COURSE_MIN_STOP_SCORE = 60;

/**
 * "주의 요인 있음(moderate)" 대상에서 대체지 중심 코스로 전환하는 최소 개선 폭.
 * 근거: 추천 노출 기준(RECO_MIN_SCORE_GAIN=5)의 2배 — 단순 노출보다 "일정 자체를
 * 바꾸라"는 더 강한 권고이므로 두 배의 확신을 요구하는 설계값.
 */
export const COURSE_ANCHOR_SWITCH_MIN_GAIN = 10;

/**
 * 산불 준비 문구를 띄우는 최소 단계.
 * 근거: 산림청 4단계 중 3단계('높음')부터 입산 통제·화기 단속이 통상 강화됨.
 */
export const CHECKLIST_FIRE_LEVEL = 3;

// ─────────────────────────────────────────────
// 민감도 분석용 교란 주입 — 스크립트·테스트 전용
// ─────────────────────────────────────────────
/**
 * 안전층 감점·환경유형 가중을 일시적으로 덮어쓰는 주입 값.
 *
 * 용도: "이 값이 ±20% 달랐다면 등급이 바뀌었을까"를 **실제 서비스 엔진으로** 재현하기
 *   위한 것이다(scripts/safety-sensitivity.ts). 별도 포팅으로 재계산하면 엔진과
 *   어긋날 수 있어(analysis/safety_engine.py의 전례), 주입 구멍을 두고 원본을 돌린다.
 *
 * 기본값은 이 파일의 상수가 유일한 출처다 — tuning을 전달하지 않으면 동작이 완전히
 * 동일하다(score.test.ts가 검증). 프로덕션 경로에서는 전달하지 않는다.
 */
export interface SafetyTuning {
  /** 산불 단계별 감점 (기본 FOREST_FIRE.POINTS_BY_LEVEL) */
  fire?: Record<1 | 2 | 3 | 4, number>;
  /** 산사태 단계별 감점 (기본 LANDSLIDE.POINTS_BY_LEVEL) */
  landslide?: Record<0 | 1 | 2, number>;
  /** 호우 밴드별 감점 (기본 HEAVY_RAIN.POINTS) */
  heavyRain?: { pre: number; watch: number; warn: number };
  /** 응급의료 감점 배율 — 표시 상한도 함께 스케일된다 (기본 1) */
  medicalMult?: number;
  /** 한파 감점 배율 — 표시 상한도 함께 스케일된다 (기본 1). 곡선 크기가 설계값이라 교란 대상 */
  coldMult?: number;
  /**
   * 쾌적층 축 가중 덮어쓰기 (기본 tci.ts TCI_WEIGHTS).
   * 미세먼지 22%가 KTCI에 없는 설계값이라, 그 값이 등급을 바꾸는지 재려면 필요하다.
   * 가중은 합으로 재정규화되므로 한 축을 올리면 나머지가 그만큼 줄어든다.
   */
  tciWeights?: TciWeights;
  /** 환경유형 가중 부분 덮어쓰기 (기본 ENV_WEIGHT). 절제 실험은 전 축을 1로 준다 */
  env?: Partial<Record<PlaceEnvType, Partial<EnvWeight>>>;
}
