/**
 * 추천 품질 측정 하네스 — 대체지 추천(reco/alternatives.ts)의 다양성·커버리지를 잰다.
 *
 * 왜 만드나: 안전점수는 설계값을 민감도 6.4만 건으로 방어하는데(24번), 추천 쪽에는
 *   대응물이 없었다. 추천에는 "정답 셋"이 없어 정확도(NDCG·Precision@k)를 잴 수 없으므로,
 *   **라벨 없이 잴 수 있는 목표(beyond-accuracy objectives)** 를 측정한다 —
 *   다양성·커버리지·제약 충족률. 근거: Kaminskas & Bridge,
 *   "Diversity, Serendipity, Novelty, and Coverage", ACM TiiS 2016.
 *
 * 결정적이다: 실제 좌표·카테고리(gangwon.json)에 **고정 기상 시나리오**를 물려
 *   실제 점수 엔진을 돌린다. 날씨 API를 타지 않으므로 언제 돌려도 같은 값이 나온다.
 *   (다양성은 카탈로그의 지리·분류 구조에서 나오므로 실좌표가 필요하다.)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { computeSafetyScore } from "../src/lib/safety/score";
import { applyEnvTypeOverrides } from "../src/lib/tour/env-overrides";
import { nearestHospitalKm } from "../src/lib/risk/medical";
import { haversineKm } from "../src/lib/reco/distance";
import {
  MAX_DISTANCE_KM,
  pairSimilarity,
  recommendAlternatives,
} from "../src/lib/reco/alternatives";
import type { PlaceWithSafety } from "../src/lib/datasource";
import type { RiskInput } from "../src/lib/safety/types";
import type { Place } from "../src/lib/tour/types";

/** "같은 동네" 판정 거리 — alternatives.ts NEIGHBORHOOD_KM과 같은 눈금 */
const NEIGHBORHOOD_KM = 15;
/** target 표본 간격 — 관광지를 contentId 오름차순으로 정렬해 N곳마다 하나 */
const TARGET_STRIDE = 5;

export type Mode = "mmr" | "baseline";

export interface Scenario {
  key: string;
  label: string;
  input: Omit<RiskInput, "emergencyRoomKm">;
}

/**
 * 고정 시나리오 3종. 기상적으로 모순인 조합(호우 + 산불 고단계)을 만들지 않는다 —
 * 안전 민감도 하네스와 같은 원칙(산불은 건조, 호우는 강우).
 */
export const SCENARIOS: Scenario[] = [
  {
    key: "clear",
    label: "맑음",
    input: {
      tempC: 22, apparentTempC: 22, tminC: 14, rainProbPct: 10, rainMm: 0,
      windMs: 2, sunHours: 8, pm25: 12, forestFireLevel: 1, landslideLevel: 0,
    },
  },
  {
    key: "rainy",
    label: "우천",
    input: {
      tempC: 19, apparentTempC: 19, tminC: 15, rainProbPct: 80, rainMm: 35,
      windMs: 6, sunHours: 2, pm25: 20, forestFireLevel: 1, landslideLevel: 0,
    },
  },
  {
    key: "heat_fire",
    label: "폭염·산불 3단계",
    input: {
      tempC: 34, apparentTempC: 36, tminC: 25, rainProbPct: 10, rainMm: 0,
      windMs: 3, sunHours: 9, pm25: 40, forestFireLevel: 3, landslideLevel: 0,
    },
  },
];

const ROOT = path.resolve(import.meta.dirname, "..");

/** 실데이터 장소 — 서비스와 같은 envType 보정을 적용한다 */
export function loadPlaces(): Place[] {
  const raw = JSON.parse(
    readFileSync(path.join(ROOT, "src/data/gangwon.json"), "utf8"),
  ) as Place[];
  return applyEnvTypeOverrides(raw);
}

/** 시나리오 하나를 전 장소에 물려 점수를 계산 — 실제 엔진 그대로 */
export function scorePlaces(places: Place[], scenario: Scenario): PlaceWithSafety[] {
  return places.map((p) => ({
    ...p,
    safety: computeSafetyScore(
      { ...scenario.input, emergencyRoomKm: nearestHospitalKm(p.lat, p.lng, p.contentId) },
      p,
      "default",
    ),
  }));
}

/** 평가 대상 target — 관광지를 contentId 순으로 정렬해 일정 간격으로 뽑는다(결정적) */
export function pickTargets(scored: PlaceWithSafety[]): PlaceWithSafety[] {
  return scored
    .filter((p) => p.contentTypeId === 12)
    .sort((a, b) => a.contentId - b.contentId)
    .filter((_, i) => i % TARGET_STRIDE === 0);
}

export interface RecoMetrics {
  scenario: string;
  mode: Mode;
  /** 평가한 target 수 */
  targets: number;
  /** 대체지가 1건 이상 나온 target 비율 */
  fillRate: number;
  /** target당 평균 추천 수 */
  meanCount: number;
  /** 추천된 대체지의 평균 점수 개선폭 (alt − target) */
  meanGain: number;
  /** 목록 안의 서로 다른 소분류(cat3) 수 평균 — 엔진 척도와 무관한 독립 지표 */
  meanDistinctCat3: number;
  /** 목록 안 쌍 평균 거리(km) — 독립 지표 */
  meanPairKm: number;
  /** Intra-List Diversity = 1 − 평균 쌍 유사도 (엔진과 같은 척도, 참고용) */
  ild: number;
  /** 목록 전체가 같은 cat3인 비율 (낮을수록 좋다) */
  monoCat3Rate: number;
  /** 목록의 모든 쌍이 15km 이내인 비율 — "전부 같은 동네" (낮을수록 좋다) */
  monoNeighborhoodRate: number;
  /** 한 번이라도 추천된 고유 장소 / 추천 가능 장소(관광지·문화시설) */
  coverage: number;
  /** 하드 제약 위반 건수 — 0이어야 한다 */
  violations: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function measure(
  scored: PlaceWithSafety[],
  scenario: Scenario,
  mode: Mode,
): RecoMetrics {
  const targets = pickTargets(scored);
  const poolSize = scored.filter(
    (p) => p.contentTypeId === 12 || p.contentTypeId === 14,
  ).length;

  const counts: number[] = [];
  const gains: number[] = [];
  const distinctCat3: number[] = [];
  const pairKms: number[] = [];
  const ilds: number[] = [];
  const recommended = new Set<number>();
  let filled = 0;
  let monoCat3 = 0;
  let monoNeighborhood = 0;
  let multiLists = 0;
  let violations = 0;

  for (const target of targets) {
    const alts = recommendAlternatives(target, scored, 4, MAX_DISTANCE_KM, {
      diversify: mode === "mmr",
    });
    counts.push(alts.length);
    if (alts.length > 0) filled++;

    for (const a of alts) {
      recommended.add(a.contentId);
      gains.push(a.safety.score - target.safety.score);
      // 하드 제약: 반경 / 최소 개선 / 자기 자신 아님
      if (
        a.distanceKm > MAX_DISTANCE_KM ||
        a.safety.score < target.safety.score + 5 ||
        a.contentId === target.contentId
      ) {
        violations++;
      }
    }

    if (alts.length < 2) continue;
    multiLists++;
    distinctCat3.push(new Set(alts.map((a) => a.cat3 ?? "")).size);
    if (new Set(alts.map((a) => a.cat3 ?? "")).size === 1) monoCat3++;

    const kms: number[] = [];
    const sims: number[] = [];
    for (let i = 0; i < alts.length; i++) {
      for (let j = i + 1; j < alts.length; j++) {
        kms.push(haversineKm(alts[i].lat, alts[i].lng, alts[j].lat, alts[j].lng));
        sims.push(pairSimilarity(alts[i], alts[j]));
      }
    }
    pairKms.push(mean(kms));
    ilds.push(1 - mean(sims));
    if (kms.every((k) => k <= NEIGHBORHOOD_KM)) monoNeighborhood++;
  }

  return {
    scenario: scenario.key,
    mode,
    targets: targets.length,
    fillRate: filled / targets.length,
    meanCount: mean(counts),
    meanGain: mean(gains),
    meanDistinctCat3: mean(distinctCat3),
    meanPairKm: mean(pairKms),
    ild: mean(ilds),
    monoCat3Rate: multiLists ? monoCat3 / multiLists : 0,
    monoNeighborhoodRate: multiLists ? monoNeighborhood / multiLists : 0,
    coverage: recommended.size / poolSize,
    violations,
  };
}

export function runAll(): RecoMetrics[] {
  const places = loadPlaces();
  const out: RecoMetrics[] = [];
  for (const scenario of SCENARIOS) {
    const scored = scorePlaces(places, scenario);
    for (const mode of ["baseline", "mmr"] as const) {
      out.push(measure(scored, scenario, mode));
    }
  }
  return out;
}
