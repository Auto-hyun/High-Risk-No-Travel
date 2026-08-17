/**
 * 안전점수 민감도 분석 — 순수 모듈 (부작용 없음. 실행은 safety-sensitivity.report.ts).
 *
 * 목적: 근거가 "설계값"인 감점 밴드와 환경유형 가중이 **최종 등급을 바꾸는가**를 잰다.
 *   축의 존재·임계점은 정부 공인 기준에 앵커돼 있지만(analysis/25_safety_evidence_map.md),
 *   밴드 절대값(산불 15/45/80 등)과 envType 배율(계곡 강수 ×1.5 등)은 설계값이다.
 *   그 값을 흔들어도 등급이 유지된다면, 근거 부재가 의사결정에 영향을 주지 않음을 뜻한다.
 *
 * 왜 TS인가: 서비스가 실제로 쓰는 computeSafetyScore를 그대로 호출한다. 별도 포팅으로
 *   재계산하면 엔진과 어긋난다(analysis/safety_engine.py가 v1에 고착된 전례).
 *   "발표에서 말하는 숫자 = 서비스가 쓰는 엔진"이 정의상 보장된다.
 *
 * 기상 입력은 시나리오 상수라 네트워크·키 불필요하고 결과가 결정적이다.
 */
import { computeSafetyScore } from "../src/lib/safety/score";
import {
  ENV_WEIGHT,
  FOREST_FIRE,
  HEAVY_RAIN,
  LANDSLIDE,
  coldPoints,
  type EnvWeight,
  type SafetyTuning,
} from "../src/lib/safety/weights";
import { TCI_WEIGHTS } from "../src/lib/safety/tci";
import type { RiskInput, RiskLevel } from "../src/lib/safety/types";
import type { PlaceEnvType } from "../src/lib/tour/types";

// ─────────────────────────────────────────────
// 시나리오 그리드
// ─────────────────────────────────────────────

/** 체감온도(℃) — 한파·선선·쾌적·더위·폭염경보급 */
const FEELS_C = [-5, 12, 22, 31, 36] as const;
/** PM2.5 — 좋음·보통·매우나쁨 */
const PM25 = [10, 30, 90] as const;

/**
 * 강수 × 산불 × 산사태를 **기상적으로 가능한 조합으로만** 묶는다.
 *
 * 세 축을 독립적으로 곱하면 "호우경보급 95mm + 산불 매우높음 + 산사태 경보" 같은 셀이
 * 생기는데, 이건 물리적으로 모순이다 — 산불은 건조, 산사태는 강우에서 발생한다
 * (weights.ts LANDSLIDE 주석). 그런 셀은 감점이 100을 훌쩍 넘어 0점으로 포화하고,
 * 포화 셀은 어떤 교란에도 등급이 안 움직여 **유지율을 인위적으로 끌어올린다.**
 *
 * 그래서 강수량이 오르면 산불 단계 상한을 낮추고, 산사태는 비가 와야 발령되게 둔다.
 */
const WEATHER_COMBOS: Array<{
  rainMm: number;
  rainProbPct: number;
  fireLevels: readonly (1 | 2 | 3 | 4)[];
  /** undefined = 공식 발령 없음(강우×지형 프록시만 작동) */
  landslideLevels: readonly (undefined | 1 | 2)[];
}> = [
  // 건조 — 산불 전 단계가 가능하고 산사태는 발령되지 않는다
  { rainMm: 0, rainProbPct: 10, fireLevels: [1, 2, 3, 4], landslideLevels: [undefined] },
  // 약한 비 — 산불 위험이 내려가고 산사태는 아직
  { rainMm: 10, rainProbPct: 60, fireLevels: [1, 2], landslideLevels: [undefined] },
  // 호우주의보급 — 산불 낮음, 산사태 주의보 가능
  { rainMm: 45, rainProbPct: 85, fireLevels: [1], landslideLevels: [undefined, 1] },
  // 호우경보급 — 산사태 경보까지
  { rainMm: 95, rainProbPct: 95, fireLevels: [1], landslideLevels: [undefined, 1, 2] },
];
/** 응급의료 거리(km) — 도심·중간·오지 3단계 */
const ACCESS = [{ erKm: 5 }, { erKm: 18 }, { erKm: 35 }] as const;
const ENV_TYPES: PlaceEnvType[] = [
  "indoor",
  "outdoor_water",
  "outdoor_mountain",
  "outdoor_coast",
  "outdoor_general",
];

/** 교란 대상이 아닌 축은 고정 — 그리드 폭발을 막고 안전층 신호를 또렷하게 둔다 */
const FIXED_WIND_MS = 3;
const FIXED_SUN_HOURS = 7;
/**
 * 일교차(℃) — 최저기온은 그리드 축을 늘리지 않고 체감온도에서 파생시킨다.
 * 7을 쓰면 가장 추운 셀(-5℃)의 최저가 -12℃가 되어 한파주의보 기준에 정확히 닿는다.
 * 나머지 셀은 -5℃를 넘어 한파 감점 0 — 즉 한파 교란의 활성 셀은 최저온 구간뿐이다.
 */
const DIURNAL_RANGE_C = 7;

export interface Cell {
  input: RiskInput;
  envType: PlaceEnvType;
}

/** 기상 조합에서 (산불 × 산사태) 경우의 수를 펼친 값 */
const WEATHER_CASES = WEATHER_COMBOS.reduce(
  (n, c) => n + c.fireLevels.length * c.landslideLevels.length,
  0,
);

/** 전체 조합 = 체감 5 × 기상케이스 × PM 3 × 접근성 3 × 환경유형 5 */
export const GRID_SIZE =
  FEELS_C.length * WEATHER_CASES * PM25.length * ACCESS.length * ENV_TYPES.length;

export function buildGrid(): Cell[] {
  const cells: Cell[] = [];
  for (const feels of FEELS_C)
    for (const w of WEATHER_COMBOS)
      for (const forestFireLevel of w.fireLevels)
        for (const landslideLevel of w.landslideLevels)
          for (const pm25 of PM25)
            for (const acc of ACCESS)
              for (const envType of ENV_TYPES)
                cells.push({
                  envType,
                  input: {
                    tempC: feels,
                    apparentTempC: feels,
                    tminC: feels - DIURNAL_RANGE_C,
                    rainProbPct: w.rainProbPct,
                    rainMm: w.rainMm,
                    windMs: FIXED_WIND_MS,
                    sunHours: FIXED_SUN_HOURS,
                    pm25,
                    forestFireLevel,
                    landslideLevel,
                    emergencyRoomKm: acc.erKm,
                  },
                });
  return cells;
}

/**
 * 중기예보 결측 케이스 — 풍속·일조·강수량이 없어 TCI가 축을 제외하고 재정규화하는 구간.
 * 요인 게이지가 표시 상한을 넘지 않는지(E4) 확인하는 용도라 그리드를 작게 둔다.
 */
export function buildMissingFieldGrid(): Cell[] {
  const cells: Cell[] = [];
  for (const feels of FEELS_C)
    for (const pm25 of PM25)
      for (const envType of ENV_TYPES)
        cells.push({
          envType,
          input: {
            tempC: feels,
            apparentTempC: feels,
            rainProbPct: 90,
            pm25,
            forestFireLevel: 1,
            emergencyRoomKm: 12,
          },
        });
  return cells;
}

// ─────────────────────────────────────────────
// 교란 세트
// ─────────────────────────────────────────────

export type Tier = "A" | "B" | "C";

export interface Perturbation {
  tier: Tier;
  name: string;
  tuning: SafetyTuning;
  /** 이 교란이 의미를 갖는 셀인가 — 유지율 분모를 여기로 좁힌다 */
  isActive: (cell: Cell) => boolean;
}

const scaleRecord = <K extends number>(
  rec: Record<K, number>,
  f: number,
): Record<K, number> =>
  Object.fromEntries(
    Object.entries(rec).map(([k, v]) => [k, (v as number) * f]),
  ) as Record<K, number>;

/** envType 한 축만 배율 조정 */
const envAxis = (
  envType: PlaceEnvType,
  axis: keyof EnvWeight,
  f: number,
): SafetyTuning => ({
  env: { [envType]: { [axis]: ENV_WEIGHT[envType][axis] * f } },
});

const isFireActive = (c: Cell) => c.input.forestFireLevel >= 2;
const isHeavyRainActive = (c: Cell) => (c.input.rainMm ?? 0) >= HEAVY_RAIN.PRE_MM;
/** 산사태는 산림청 공식 발령이 있는 셀에서만 감점이 발생한다 */
const isLandslideActive = (c: Cell) => (c.input.landslideLevel ?? 0) > 0;
const isEnvActive = (envType: PlaceEnvType) => (c: Cell) => c.envType === envType;
/** 한파는 최저기온이 감점 시작점(-5℃) 아래로 내려간 셀에서만 의미가 있다 */
const isColdActive = (c: Cell) =>
  c.input.tminC !== undefined && coldPoints(c.input.tminC) > 0;

/** ±20% — 24_safety_sensitivity.md가 채택한 교란 폭 */
const FACTORS = [0.8, 1.2] as const;

export function buildPerturbations(): Perturbation[] {
  const out: Perturbation[] = [];

  for (const f of FACTORS) {
    const pct = `${f < 1 ? "−" : "+"}20%`;

    // ── Tier A: 안전층 밴드 (근거 = 등급컷 앵커 설계값) ──
    out.push({
      tier: "A",
      name: `산불 밴드 ${pct}`,
      tuning: { fire: scaleRecord(FOREST_FIRE.POINTS_BY_LEVEL, f) },
      isActive: isFireActive,
    });
    out.push({
      tier: "A",
      name: `산사태 밴드 ${pct}`,
      tuning: { landslide: scaleRecord(LANDSLIDE.POINTS_BY_LEVEL, f) },
      isActive: isLandslideActive,
    });
    out.push({
      tier: "A",
      name: `호우 밴드 ${pct}`,
      tuning: {
        heavyRain: {
          pre: HEAVY_RAIN.POINTS.pre * f,
          watch: HEAVY_RAIN.POINTS.watch * f,
          warn: HEAVY_RAIN.POINTS.warn * f,
        },
      },
      isActive: isHeavyRainActive,
    });
    out.push({
      tier: "A",
      name: `응급의료 ${pct}`,
      tuning: { medicalMult: f },
      isActive: () => true,
    });
    out.push({
      tier: "A",
      name: `한파 곡선 ${pct}`,
      tuning: { coldMult: f },
      isActive: isColdActive,
    });
    out.push({
      tier: "A",
      name: `안전층 전체 동시 ${pct}`,
      tuning: {
        fire: scaleRecord(FOREST_FIRE.POINTS_BY_LEVEL, f),
        landslide: scaleRecord(LANDSLIDE.POINTS_BY_LEVEL, f),
        heavyRain: {
          pre: HEAVY_RAIN.POINTS.pre * f,
          watch: HEAVY_RAIN.POINTS.watch * f,
          warn: HEAVY_RAIN.POINTS.warn * f,
        },
        medicalMult: f,
        coldMult: f,
      },
      isActive: () => true,
    });

    // ── Tier B: 설계값 가중·배율 (근거 = 방향만 탐색적이거나, 크기가 설계값) ──
    // 미세먼지 축 가중 22%는 KTCI에 없는 우리 확장이라 근거가 없다. 가중은 합으로
    // 재정규화되므로 pm을 올리면 나머지 4축이 그만큼 줄어든다 — 축 간 배분 자체의 교란
    out.push({
      tier: "B",
      name: `미세먼지 축 가중 22% ${pct}`,
      tuning: { tciWeights: { ...TCI_WEIGHTS, pm: TCI_WEIGHTS.pm * f } },
      isActive: () => true,
    });
    out.push({
      tier: "B",
      name: `계곡·수변 강수 ×1.5 ${pct}`,
      tuning: envAxis("outdoor_water", "rain", f),
      isActive: isEnvActive("outdoor_water"),
    });
    out.push({
      tier: "B",
      name: `산악 강풍 ×1.3 ${pct}`,
      tuning: envAxis("outdoor_mountain", "wind", f),
      isActive: isEnvActive("outdoor_mountain"),
    });
    out.push({
      tier: "B",
      name: `산악 산불 ×1.3 ${pct}`,
      tuning: envAxis("outdoor_mountain", "fire", f),
      isActive: (c) => c.envType === "outdoor_mountain" && isFireActive(c),
    });
    out.push({
      tier: "B",
      name: `해안 강풍 ×1.5 ${pct}`,
      tuning: envAxis("outdoor_coast", "wind", f),
      isActive: isEnvActive("outdoor_coast"),
    });
    out.push({
      tier: "B",
      name: `실내 할인 ×0.3 ${pct}`,
      tuning: {
        env: {
          indoor: {
            heat: ENV_WEIGHT.indoor.heat * f,
            rain: ENV_WEIGHT.indoor.rain * f,
            wind: ENV_WEIGHT.indoor.wind * f,
            pm: ENV_WEIGHT.indoor.pm * f,
            fire: ENV_WEIGHT.indoor.fire * f,
          },
        },
      },
      isActive: isEnvActive("indoor"),
    });
  }

  // ── Tier C: 절제(ablation) — "근거 없는 층이 결정에 얼마나 관여하는가" ──
  const flat: EnvWeight = { heat: 1, rain: 1, wind: 1, pm: 1, fire: 1 };
  out.push({
    tier: "C",
    name: "envType 가중 전체 제거 (전부 1.0)",
    tuning: {
      env: Object.fromEntries(ENV_TYPES.map((e) => [e, flat])) as SafetyTuning["env"],
    },
    isActive: () => true,
  });
  out.push({
    tier: "C",
    name: "실내 할인만 제거 (indoor 1.0)",
    tuning: { env: { indoor: flat } },
    isActive: isEnvActive("indoor"),
  });

  return out;
}

// ─────────────────────────────────────────────
// 측정
// ─────────────────────────────────────────────

export interface Result {
  tier: Tier;
  name: string;
  /** 교란이 의미를 갖는 셀 수 */
  activeCells: number;
  /** 활성 셀 중 등급이 유지된 비율 — 헤드라인 지표 */
  keepRateActive: number;
  /** 전체 셀 기준 (참고용 — 비활성 셀이 분모에 들어가 부풀려진다) */
  keepRateAll: number;
  /** 활성 셀 중 base score가 0 또는 100인 비율 — 어떤 교란에도 안 움직이는 셀 */
  saturatedRate: number;
  /** 활성 셀의 |Δscore| 평균·최대 */
  meanAbsDelta: number;
  maxAbsDelta: number;
  /** 등급이 바뀐 셀이 base에서 등급컷과 얼마나 떨어져 있었나 (평균 점) */
  meanCutDistanceOfFlips: number;
  /** 등급컷 ±5점 이내였던 flip 비율 */
  flipsNearCutRate: number;
  /**
   * 효과가 0인 이유 — 리포트가 "교란해도 등급이 안정적"과 "애초에 감점이 안 변함"을
   * 구분하게 한다. 후자를 유지율 100%로 읽으면 근거 부담이 없다고 오해하게 된다.
   *
   * 감점 불변의 원인은 두 가지이고 결과만으로는 구별되지 않는다:
   *   ① 구조적 미적용 — env.fire는 할인(<1)만 반영되므로 1.3을 흔들어도 무시된다
   *   ② 반올림 흡수 — Math.round 뒤 같은 정수로 떨어진다 (산악 강풍 +20%가 이 경우)
   */
  zeroEffectReason: "대상 셀 없음" | "감점 불변(미적용 또는 반올림 흡수)" | null;
}

const CUTS = [40, 70];
const cutDistance = (score: number) =>
  Math.min(...CUTS.map((c) => Math.abs(score - c)));

export interface Baseline {
  score: number;
  grade: RiskLevel;
}

export function computeBaseline(cells: Cell[]): Baseline[] {
  return cells.map((c) => {
    const b = computeSafetyScore(c.input, { envType: c.envType }, "default");
    return { score: b.score, grade: b.grade };
  });
}

export function measure(
  cells: Cell[],
  baseline: Baseline[],
  p: Perturbation,
): Result {
  let activeCells = 0;
  let keptActive = 0;
  let keptAll = 0;
  let saturated = 0;
  let sumAbsDelta = 0;
  let maxAbsDelta = 0;
  let anyScoreChanged = false;
  const flipCutDistances: number[] = [];

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const base = baseline[i];
    const after = computeSafetyScore(
      cell.input,
      { envType: cell.envType },
      "default",
      p.tuning,
    );
    const kept = after.grade === base.grade;
    if (kept) keptAll++;

    if (!p.isActive(cell)) continue;
    activeCells++;
    if (kept) keptActive++;
    else flipCutDistances.push(cutDistance(base.score));

    if (base.score === 0 || base.score === 100) saturated++;
    const d = Math.abs(after.score - base.score);
    if (d > 0) anyScoreChanged = true;
    sumAbsDelta += d;
    if (d > maxAbsDelta) maxAbsDelta = d;
  }

  const nearCut = flipCutDistances.filter((d) => d <= 5).length;
  return {
    tier: p.tier,
    name: p.name,
    activeCells,
    keepRateActive: activeCells ? keptActive / activeCells : 1,
    keepRateAll: keptAll / cells.length,
    saturatedRate: activeCells ? saturated / activeCells : 0,
    meanAbsDelta: activeCells ? sumAbsDelta / activeCells : 0,
    maxAbsDelta,
    meanCutDistanceOfFlips: flipCutDistances.length
      ? flipCutDistances.reduce((a, b) => a + b, 0) / flipCutDistances.length
      : 0,
    flipsNearCutRate: flipCutDistances.length ? nearCut / flipCutDistances.length : 0,
    zeroEffectReason:
      activeCells === 0
        ? "대상 셀 없음"
        : !anyScoreChanged
          ? "감점 불변(미적용 또는 반올림 흡수)"
          : null,
  };
}

export function runAll(): { cells: Cell[]; results: Result[] } {
  const cells = buildGrid();
  const baseline = computeBaseline(cells);
  const results = buildPerturbations().map((p) => measure(cells, baseline, p));
  return { cells, results };
}

// ─────────────────────────────────────────────
// 부가 측정 — 요인 게이지 상한 초과(E4)와 시군 내 변별(E1)
// ─────────────────────────────────────────────

export interface GaugeOverflow {
  cellsChecked: number;
  overflowCells: number;
  worst: { key: string; points: number; maxPoints: number } | null;
}

/** 어떤 요인도 표시 상한(maxPoints)을 넘지 않아야 한다 — 넘으면 게이지가 100%를 초과한다 */
export function checkGaugeOverflow(cells: Cell[]): GaugeOverflow {
  let overflowCells = 0;
  let worst: GaugeOverflow["worst"] = null;
  for (const c of cells) {
    const b = computeSafetyScore(c.input, { envType: c.envType }, "default");
    let over = false;
    for (const f of b.factors) {
      if (f.points > f.maxPoints) {
        over = true;
        const excess = f.points - f.maxPoints;
        if (!worst || excess > worst.points - worst.maxPoints) {
          worst = { key: f.key, points: f.points, maxPoints: f.maxPoints };
        }
      }
    }
    if (over) overflowCells++;
  }
  return { cellsChecked: cells.length, overflowCells, worst };
}

/**
 * envType이 만드는 변별력 — 같은 날씨 입력에서 envType만 달라질 때 점수가 몇 개로 갈리는가.
 * 발표자료 부록의 "기상은 시군 단위인데 관광지 위험을 설명 가능한가 → 환경유형 가중으로
 * 보정한다"는 방어가 실제로 참인지에 숫자로 답한다.
 */
export interface EnvSpread {
  /** 날씨 조합당 서로 다른 점수의 개수 (envType 5종 기준) 평균 */
  meanDistinctScores: number;
  /** 날씨 조합당 최고−최저 점수 차 평균 */
  meanSpread: number;
  /** envType만으로 등급이 갈리는 날씨 조합 비율 */
  gradeSplitRate: number;
}

export function measureEnvSpread(cells: Cell[]): EnvSpread {
  // envType을 제외한 입력이 같은 셀끼리 묶는다
  const groups = new Map<string, number[]>();
  const grades = new Map<string, Set<RiskLevel>>();
  for (const c of cells) {
    const key = JSON.stringify(c.input);
    const b = computeSafetyScore(c.input, { envType: c.envType }, "default");
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(b.score);
    (grades.get(key) ?? grades.set(key, new Set()).get(key)!).add(b.grade);
  }
  let distinct = 0;
  let spread = 0;
  let split = 0;
  for (const [key, scores] of groups) {
    distinct += new Set(scores).size;
    spread += Math.max(...scores) - Math.min(...scores);
    if ((grades.get(key)?.size ?? 1) > 1) split++;
  }
  const n = groups.size;
  return {
    meanDistinctScores: distinct / n,
    meanSpread: spread / n,
    gradeSplitRate: split / n,
  };
}
