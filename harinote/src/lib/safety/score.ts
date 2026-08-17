/**
 * 안전 점수 엔진 — 쾌적층(관광기후지수 TCI) − 안전층(재난·의료 취약성).
 *
 * SafetyScore = TCI(쾌적) − 안전 감점(산불·산사태·응급의료)
 * - 쾌적층: 관광기후지수(K-TCI/KTCI) — 체감온도·강수·미세먼지·바람. envType(실내 할인·
 *   계곡 강수 가중)·프로필(민감층)로 변조. 근거=tci.ts, analysis/23.
 * - 안전층: 산불·산사태(산림청 단계) + 응급의료 접근성(취약성). FEMA/지역안전지수 구조.
 * - 재난 경보급(산불 4단계·산사태 경보): 감점(80)이 등급컷에 앵커돼 총점이 ALERT_BAND_CAP
 *   이하로 보장된다 — 별도 override 로직이 아니라 앵커 설계의 결과.
 *   근거=기상청 관광기후지수 '특보발령주의' 등급 + 특보 2단계(경보=이동 자제).
 * - 점수 = 100 − 감점 합. 단 재난이 겹쳐 감점 합이 100을 넘으면 0점에서 멈춘다
 *   (요인 막대의 합이 100을 넘는 화면이 존재한다). 그 구간은 이미 최하 등급이라
 *   등급 판정은 달라지지 않는다.
 */
import type { Place } from "@/lib/tour/types";
import type {
  Profile,
  RiskBreakdown,
  RiskFactor,
  RiskInput,
} from "@/lib/safety/types";
import {
  COLD,
  ENV_WEIGHT,
  FOREST_FIRE,
  HEAT_SHIFT_FLOOR_C,
  HEAVY_RAIN,
  coldPoints,
  LANDSLIDE,
  MEDICAL,
  PROFILE_WEIGHT,
  SUN_RAIN_ADJ,
  type SafetyTuning,
  gradeForScore,
  heavyRainPoints,
  landslideEffectiveLevel,
  normalizeLandslideLevel,
  normalizeForestFireLevel,
  levelForPoints,
  medicalPoints,
  pmGradeLabel,
} from "@/lib/safety/weights";
import { computeTciBreakdown } from "@/lib/safety/tci";

/** 재난 경보급(산불4·산사태2)일 때 감점 앵커(80)로 보장되는 총점 상한 — 강제(override)가
 * 아니라 앵커 설계의 결과다. 불변식·테스트 참조용. (기상청 '특보발령주의' 밴드) */
export const ALERT_BAND_CAP = 20;


export function computeSafetyScore(
  input: RiskInput,
  place: Pick<Place, "envType">,
  profile: Profile = "default",
  tuning: SafetyTuning = {},
): RiskBreakdown {
  const envOverride = tuning.env?.[place.envType];
  const env = envOverride
    ? { ...ENV_WEIGHT[place.envType], ...envOverride }
    : ENV_WEIGHT[place.envType];
  const prof = PROFILE_WEIGHT[profile];
  const factors: RiskFactor[] = [];

  // 안전층 밴드·배율 — tuning 미전달 시 weights.ts 상수 그대로다(동작 동일).
  // 표시 상한도 밴드와 함께 스케일해야 교란이 clamp에 흡수되지 않는다.
  const fireBand = tuning.fire ?? FOREST_FIRE.POINTS_BY_LEVEL;
  const fireMax = tuning.fire
    ? Math.max(...Object.values(tuning.fire))
    : FOREST_FIRE.MAX_POINTS;
  const lsBand = tuning.landslide ?? LANDSLIDE.POINTS_BY_LEVEL;
  const lsMax = tuning.landslide
    ? Math.max(...Object.values(tuning.landslide))
    : LANDSLIDE.MAX_POINTS;
  const hrBand = tuning.heavyRain ?? HEAVY_RAIN.POINTS;
  const medicalMult = tuning.medicalMult ?? 1;
  const medicalMax = MEDICAL.MAX_POINTS * medicalMult;

  // ── 쾌적층: 관광기후지수(TCI) ──
  // 폭염특보 기준이 "일 최고 체감온도"이므로 체감온도(apparentTempC) 우선, 없으면 건구온도.
  // 민감층은 체감온도를 상향 반영(같은 더위도 더 위험) → thermal 입력 보정.
  // 단 더위 쪽에서만 — 근거는 weights.ts HEAT_SHIFT_FLOOR_C.
  const feelsBase = input.apparentTempC ?? input.tempC;
  const feelsEff =
    feelsBase >= HEAT_SHIFT_FLOOR_C ? feelsBase + prof.heatShiftC : feelsBase;
  const tb = computeTciBreakdown({
    feelsC: feelsEff,
    rainMmDaily: input.rainMm,
    rainProbPct: input.rainProbPct,
    windMs: input.windMs,
    pm25: input.pm25,
    // 민감군(아이 동반)은 배율이 아니라 곡선으로 — 폭염의 임계값 하향과 같은 구조다
    // (근거: analysis/NOTE_민감층_임계값.md, EPA AQI USG). 배점은 그대로 둔다.
    pmSensitive: prof.pmSensitive,
    sunHours: input.sunHours, // 하늘상태(SKY) 환산 — 없으면 TCI가 4축 재정규화
  }, tuning.tciWeights);

  // envType·프로필로 변조 (실내 할인·계곡 강수 가중·미먼 민감군).
  // 표시 상한도 같은 계수를 곱한다 — "이 장소에서 이 축이 최대로 깎을 수 있는 점수"라야
  // 게이지가 배점을 넘지 않고, 상한 자체가 KTCI 가중에서 파생된다는 근거가 유지된다.
  const pmMult = env.pm;
  const thermalPts = Math.round(tb.deductions.thermal * env.heat);
  const thermalMax = Math.round(tb.shares.thermal * env.heat);
  // 강수(쾌적, TCI) — 비로 관광이 불편한 정도. 침수·급류 위험은 안전층 호우로 분리.
  // KTCI 강수 32%·풍속 11.6%가 별개 가중이므로 요인도 강수·바람으로 나눠 표시(근거 일치).
  const rainPts = Math.round(tb.deductions.rain * env.rain);
  const rainMax = Math.round(tb.shares.rain * env.rain);
  const windPts = Math.round(tb.deductions.wind * env.wind);
  const windMax = Math.round(tb.shares.wind * env.wind);
  const pmPts = Math.round(tb.deductions.pm * pmMult);
  const pmMax = Math.round(tb.shares.pm * pmMult);
  // 호우 severity(침수·급류) — 안전층으로 이동. 쾌적(TCI)은 5mm에서 포화하나
  // 호우주의보(30~60mm)·경보(90mm)는 위험이라 별도 축. 지형(env.rain)에 비례.
  const heavyRain = heavyRainPoints(input.rainMm, hrBand);
  const heavyRainPts = Math.min(HEAVY_RAIN.MAX_POINTS, Math.round(heavyRain * env.rain));
  // 일조(하늘상태 SKY 환산) — 데이터 있을 때만 요인 추가. 야외 심미(실내 할인 env.heat).
  // 강수확률 연동 완화 근거는 weights.ts SUN_RAIN_ADJ 참조.
  const sunRainAdj =
    input.rainProbPct === undefined
      ? SUN_RAIN_ADJ.FACTORS.low
      : input.rainProbPct >= SUN_RAIN_ADJ.HIGH_PROB_PCT
        ? SUN_RAIN_ADJ.FACTORS.high
        : input.rainProbPct >= SUN_RAIN_ADJ.MID_PROB_PCT
          ? SUN_RAIN_ADJ.FACTORS.mid
          : SUN_RAIN_ADJ.FACTORS.low;
  // 상한에는 완화 계수를 곱하지 않는다 — 배점은 그대로인데 이번 조건에서 덜 깎였음을 보인다
  const sunPts = Math.round(tb.deductions.sun * env.heat * sunRainAdj);
  const sunMax = Math.round(tb.shares.sun * env.heat);

  const thermalNote =
    feelsBase >= 33 ? "무더위" : feelsBase <= 4 ? "추위" : feelsBase >= 28 ? "더움" : "쾌적";
  const thermalLabel =
    input.apparentTempC !== undefined
      ? `체감 ${input.apparentTempC}℃(기온 ${input.tempC}℃)`
      : `체감온도 ${input.tempC}℃`;
  factors.push({
    key: "heat",
    label: "체감온도",
    value: feelsBase,
    unit: "℃",
    threshold: 33,
    points: thermalPts,
    maxPoints: thermalMax,
    level: levelForPoints(thermalPts, thermalMax),
    description: `${thermalLabel} — ${thermalNote}${prof.heatShiftC > 0 ? " · 동반 민감 기준" : ""} (관광기후지수 열쾌적)`,
  });

  // ── 한파 (기상청 한파특보 기준 — weights.ts COLD) ──
  // 쾌적층 열쾌적과 입력이 다르다: TCI는 tempC(낮 최고)로 "관광하기 좋은가"를,
  // 이 축은 tminC(아침 최저)로 "추위가 위험한가"를 본다 — 강수(TCI)와 호우(안전층)를
  // 나눈 것과 같은 층 분리라 이중 계상이 아니다.
  // tminC가 없으면 축 비활성(중기예보·mock 경로). 추위도 열 축이라 env.heat를 그대로 쓴다.
  const coldMult = tuning.coldMult ?? 1;
  const coldMax = Math.round(COLD.MAX_POINTS * env.heat * coldMult);
  // 감점은 원값으로 계산하고 표시값만 소수 1자리로 줄인다 — 먼저 반올림하면
  // 계절 시나리오의 소수 온도가 한파 밴드 경계를 넘나들어 점수가 1점씩 흔들린다
  const coldPts =
    input.tminC === undefined
      ? 0
      : Math.round(coldPoints(input.tminC) * env.heat * coldMult);
  const tminC = input.tminC === undefined ? undefined : Math.round(input.tminC * 10) / 10;
  // 감점 0(한파 기준 미달)이면 요인을 만들지 않는다 — 여름에 "한파 0점" 막대가 서지 않게
  if (tminC !== undefined && coldPts > 0) {
    factors.push({
      key: "cold",
      label: "한파",
      value: tminC,
      unit: "℃",
      threshold: COLD.ADVISORY_C,
      points: coldPts,
      maxPoints: coldMax,
      level: levelForPoints(coldPts, coldMax),
      description: `최저기온 ${tminC}℃ — 한파주의보 기준(${COLD.ADVISORY_C}℃) ${
        tminC <= COLD.ADVISORY_C ? "이하" : "미만 접근"
      }`,
    });
  }

  factors.push({
    key: "rain",
    label: "강수",
    value: input.rainProbPct,
    unit: "%",
    threshold: 60,
    points: rainPts,
    maxPoints: rainMax,
    level: levelForPoints(rainPts, rainMax),
    description: `강수확률 ${input.rainProbPct}%${
      input.rainMm !== undefined && input.rainMm >= 3 ? ` · ${input.rainMm}mm` : ""
    } (관광기후지수 강수)`,
  });
  // 바람 요인 — 풍속 데이터 있을 때만 표시(없으면 TCI 4축 재정규화라 감점 0).
  // 중기예보(D+4~)는 풍속을 제공하지 않는다.
  if (input.windMs !== undefined) {
    factors.push({
      key: "wind",
      label: "바람",
      value: input.windMs,
      unit: "m/s",
      threshold: 9,
      points: windPts,
      maxPoints: windMax,
      level: levelForPoints(windPts, windMax),
      description: `풍속 ${input.windMs}m/s (관광기후지수 풍속)`,
    });
  }
  factors.push({
    key: "pm",
    label: "미세먼지",
    value: input.pm25,
    unit: "㎍/㎥",
    threshold: 35,
    points: pmPts,
    maxPoints: pmMax,
    level: levelForPoints(pmPts, pmMax),
    description: `PM2.5 ${input.pm25}㎍/㎥ — 환경부 '${pmGradeLabel(input.pm25)}' 등급${prof.pmSensitive ? " · 민감군 기준" : ""}`,
  });

  // 일조 요인 — SKY 데이터 있을 때만 표시(없으면 TCI 4축 재정규화라 감점 0)
  if (input.sunHours !== undefined) {
    factors.push({
      key: "sun",
      label: "일조",
      value: input.sunHours,
      unit: "h",
      threshold: 5,
      points: sunPts,
      maxPoints: sunMax,
      level: levelForPoints(sunPts, sunMax),
      description: `낮 하늘상태 환산 일조 ${input.sunHours}시간 — ${
        input.sunHours >= 8 ? "맑음" : input.sunHours >= 4 ? "구름많음" : "흐림"
      } (관광기후지수)${sunRainAdj < 1 ? " · 강수확률 높아 감점 완화(강수 축 반영)" : ""}`,
    });
  }

  const weatherRisk = thermalPts + coldPts + rainPts + windPts + pmPts + sunPts;

  // ── 안전층: 호우 침수·급류 (기상청 호우 특보 severity) ──
  // 강수 불쾌(쾌적 TCI)와 층을 분리 — "강수가 왜 두 번 깎이나"를 제거하고, 위험은
  // 안전층에서 산사태와 함께 다룬다. rainMm<30(호우 미만)이면 요인 없음.
  if (heavyRainPts > 0) {
    const hrLabel =
      (input.rainMm ?? 0) >= HEAVY_RAIN.WARN_MM
        ? "경보급"
        : (input.rainMm ?? 0) >= HEAVY_RAIN.WATCH_MM
          ? "주의보급"
          : "예비급";
    factors.push({
      key: "heavy_rain",
      label: "호우",
      value: input.rainMm ?? 0,
      unit: "mm",
      threshold: HEAVY_RAIN.PRE_MM,
      points: heavyRainPts,
      maxPoints: HEAVY_RAIN.MAX_POINTS,
      level: levelForPoints(heavyRainPts, HEAVY_RAIN.MAX_POINTS),
      description: `일강수 ${input.rainMm}mm — 기상청 호우 ${hrLabel} 침수·급류 위험`,
    });
  }

  // ── 안전층: 산불 (산림청 단계 → 여행 권고 등급 앵커) ──
  // 등급 감점(0/15/45/80)이 100점 만점 기준이라 그 자체가 등급을 보장(높음→≤55, 매우높음→≤20).
  // 환경유형 가중(env.fire)은 3단계까지만 적용한다 — 산불위험은 시군 단위 공통값이라
  // 그대로 먹이면 도심 상가 음식점이 산지와 같은 감점을 받는다(weights.ts ENV_WEIGHT 주석).
  // 반면 4단계(매우높음)는 입산통제·대피급이라 지형과 무관하게 방문자제 밴드에 남아야 한다.
  // 지금은 할인(<1)만 반영한다 — 산악 가중(1.3)은 적용 시 산불 3단계에서 산악 관광지가
  // 일괄 방문자제로 내려가는데, 그 배율의 근거가 아직 설계값이라 실증 보정 전까지 보류한다.
  const fireLevel = normalizeForestFireLevel(input.forestFireLevel);
  const fireEnv = fireLevel >= 4 ? 1 : Math.min(1, env.fire);
  const fire = Math.round(Math.min(fireMax, fireBand[fireLevel] * fireEnv));
  const fireNote = fireLevel >= 4 ? " → 방문 자제" : fireLevel >= 3 ? " → 주의" : "";
  factors.push({
    key: "forest_fire",
    label: "산불",
    value: fireLevel,
    unit: "단계",
    threshold: 3,
    points: fire,
    maxPoints: fireMax,
    level: levelForPoints(fire, fireMax),
    description: `산불위험 ${fireLevel}단계 — 산림청 '${FOREST_FIRE.LEVEL_LABEL[fireLevel]}'${fireNote}`,
  });

  // ── 안전층: 산사태 (산림청 공식 예보발령만 — 자체 추정 없음) ──
  // 실내 시설은 한 단계 완화한다 (weights.ts landslideEffectiveLevel 참조) —
  // 발령이 시군 단위라 그대로 먹이면 도심 상가 음식점이 산지와 같은 감점을 받는다.
  const landslideLevel = normalizeLandslideLevel(input.landslideLevel ?? 0);
  const lsLevel = landslideEffectiveLevel(landslideLevel, place.envType);
  let landslide = 0;
  if (lsLevel > 0) {
    landslide = Math.round(Math.min(lsMax, lsBand[lsLevel]));
    const lsNote = lsLevel >= 2 ? " → 방문 자제" : " → 주의";
    const indoorNote = lsLevel < landslideLevel ? " · 실내 시설 한 단계 완화" : "";
    factors.push({
      key: "landslide",
      label: "산사태",
      value: landslideLevel,
      unit: "단계",
      threshold: 1,
      points: landslide,
      maxPoints: lsMax,
      level: levelForPoints(landslide, lsMax),
      description: `산사태 ${LANDSLIDE.LEVEL_LABEL[landslideLevel]} 발령 — 산림청 산사태정보시스템${indoorNote}${lsNote}`,
    });
  }

  // ── 안전층: 응급의료 접근성 (취약성) ──
  const medical = Math.round(
    Math.min(
      medicalMax,
      medicalPoints(input.emergencyRoomKm) * prof.medical * medicalMult,
    ),
  );
  factors.push({
    key: "medical",
    label: "응급의료",
    value: input.emergencyRoomKm,
    unit: "km",
    threshold: MEDICAL.NEAR_KM,
    points: medical,
    maxPoints: medicalMax,
    level: levelForPoints(medical, medicalMax),
    description: `최근접 응급의료기관 ${input.emergencyRoomKm}km — 골든타임 권장(${MEDICAL.NEAR_KM}km) ${
      input.emergencyRoomKm > MEDICAL.NEAR_KM ? "초과" : "이내"
    }`,
  });

  // ── 합산: score = 100 − (쾌적 + 안전) ──
  // 재난 단계 감점이 등급컷에 앵커돼 있어(높음 45→≤55 주의, 매우높음/경보 80→≤20 방문자제)
  // 별도 override 없이 감점 합만으로 등급이 보장된다.
  // 감점 합이 100을 넘는 재난 중첩(예: 산불 매우높음 + 폭염)에서는 0점에서 멈춘다 —
  // 이때만 "점수 = 100 − 요인 합"이 성립하지 않는다. 등급은 이미 최하라 판정은 불변.
  const disasterRisk = heavyRainPts + fire + landslide;
  const medicalRisk = medical;
  const total = weatherRisk + disasterRisk + medicalRisk;
  const score = Math.max(0, Math.min(100, 100 - total));

  return {
    score,
    grade: gradeForScore(score),
    profile,
    factors,
    weatherRisk,
    disasterRisk,
    medicalRisk,
  };
}
