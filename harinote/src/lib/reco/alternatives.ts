/**
 * 안전 대체지 추천 v1 — 거리·카테고리·안전점수·실내외 적합도 기반 (제안서 핵심 기능)
 *
 * 2단계 구조다: 하드 제약으로 후보를 거르고(1), 거른 후보를 순위 매긴 뒤(2)
 * 서로 닮은 것이 몰리지 않게 다시 고른다(3).
 *
 * 1) 필터 — 자기 자신 제외 / Haversine 30km 이내 / candidate.score >=
 *    target.score + RECO_MIN_SCORE_GAIN / 유형 관련성 0점 제외
 * 2) 관련도 정렬 — (카테고리 유사도 + 실내 보정) 내림차순 → 안전점수 내림차순 → 거리 오름차순
 *    카테고리 유사도(TourAPI 분류체계): cat3 일치 3 > cat2 일치 2 > contentTypeId 일치 1
 *    실내 보정: 악천후(target.weatherRisk >= 임계) 시 실내 후보 +2
 * 3) 다양성 재랭킹(MMR) — 아래 MMR_LAMBDA 주석 참조
 */
import type { PlaceWithSafety } from "@/lib/datasource";
import {
  RECO_MIN_SCORE_GAIN,
  RECO_WEATHER_RISK_INDOOR_THRESHOLD,
} from "@/lib/safety/weights";
import { haversineKm } from "@/lib/reco/distance";

export interface Alternative extends PlaceWithSafety {
  distanceKm: number;
}

/** 대중교통 기준 후보 반경. 자차는 호출부에서 CAR_DISTANCE_KM 사용 */
export const MAX_DISTANCE_KM = 30;
/** 자차 이동 시 후보 반경 — 더 먼 대체지도 현실적 선택지 */
export const CAR_DISTANCE_KM = 50;
const INDOOR_BONUS = 2;
const DEFAULT_LIMIT = 4;

/** TourAPI 카테고리 유사도: cat3(소분류) > cat2(중분류) > contentTypeId(콘텐츠 유형) */
function categorySimilarity(
  target: PlaceWithSafety,
  candidate: PlaceWithSafety,
): number {
  if (target.cat3 && candidate.cat3 === target.cat3) return 3;
  if (target.cat2 && candidate.cat2 === target.cat2) return 2;
  if (candidate.contentTypeId === target.contentTypeId) return 1;
  return 0;
}

// ─────────────────────────────────────────────
// 다양성 재랭킹 (MMR — Maximal Marginal Relevance)
// ─────────────────────────────────────────────
/**
 * 관련도와 다양성의 배분. 1이면 기존 순위 그대로, 0이면 관련도를 무시하고 서로 다르기만 한다.
 *
 * 왜 필요한가: 2단계 정렬은 "가장 비슷하고 가장 안전하고 가장 가까운" 순이라,
 *   같은 동네 같은 소분류 관광지가 4칸을 모두 채우는 일이 생긴다. 대체지는
 *   "이 중에 하나를 고르라"고 내미는 목록이므로 4개가 사실상 한 개면 쓸모가 없다.
 *
 * 0.7은 설계값이다 ❌ — 관련도를 다양성보다 우위에 두되(>0.5) 1순위 다음부터는
 *   차이가 드러나게 하는 배분. 근거가 없으므로 효과를 측정해서 방어한다:
 *   `pnpm check:reco`가 켤 때와 끌 때의 다양성·안전점수 개선폭을 함께 낸다
 *   (analysis/33_reco_quality_result.md).
 *
 * 출처: Carbonell & Goldstein, "The Use of MMR, Diversity-Based Reranking for
 *   Reordering Documents and Producing Summaries", SIGIR 1998.
 */
export const MMR_LAMBDA = 0.7;

/**
 * MMR을 적용할 후보 풀 크기 배수 (limit × 이 값).
 * 전체 후보에 걸면 순위 차이가 1/N로 잘게 쪼개져 다양성 항이 관련도를 압도한다.
 * 상위권 안에서만 섞는 것이 MMR의 통상 용법이다.
 */
const MMR_POOL_MULTIPLIER = 5;

/**
 * "같은 동네"로 느끼는 거리 — 이보다 멀면 지리 유사도 0.
 * 후보 반경(30km)을 척도로 쓰면 25km 떨어진 곳도 0.17 닮은 것으로 잡혀,
 * 실제로는 전혀 다른 동네인 두 곳이 서로를 밀어내지 못한다. 반경의 절반을
 * 경계로 둔다 — 반나절 코스의 오후 스톱 반경(15km)과 같은 눈금이다. 설계값 ❌.
 */
const NEIGHBORHOOD_KM = 15;

/**
 * 후보 간 유사도 0~1 — 카테고리와 거리를 절반씩.
 * 대체지 목록에서 "겹친다"고 느끼는 축이 이 둘이다(같은 종류거나, 같은 동네거나).
 *
 * export하는 이유는 품질 하네스(scripts/reco-quality.ts)가 목록 내 다양성(ILD)을
 * **엔진과 같은 척도로** 재기 위해서다. 별도로 다시 구현하면 측정값이 엔진과 어긋난다.
 */
export function pairSimilarity(a: PlaceWithSafety, b: PlaceWithSafety): number {
  const cat =
    a.cat3 && b.cat3 === a.cat3
      ? 1
      : a.cat2 && b.cat2 === a.cat2
        ? 0.5
        : a.contentTypeId === b.contentTypeId
          ? 0.25
          : 0;
  const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
  const geo = Math.max(0, 1 - km / NEIGHBORHOOD_KM);
  return 0.5 * cat + 0.5 * geo;
}

/**
 * 관련도 순으로 정렬된 풀에서 MMR로 limit개를 고른다.
 *
 * 관련도는 **기존 순위의 위치**를 그대로 쓴다(1위 = 1.0, 꼴찌 = 0.0) — 별도의
 * 관련도 점수를 새로 만들면 2단계 정렬과 어긋나 "왜 이게 위인가"를 두 번
 * 설명해야 한다. 이렇게 두면 MMR은 순위를 *재배열*할 뿐 기준을 바꾸지 않는다.
 *
 * 선택된 것이 없는 첫 회차는 다양성 항이 0이므로 **1순위는 항상 기존 1순위다.**
 * 동점이면 기존 순위가 앞선 쪽 — 결과가 항상 결정적이다.
 */
function mmrSelect(pool: Alternative[], limit: number): Alternative[] {
  if (pool.length <= 1) return pool.slice(0, limit);
  const relevance = pool.map((_, i) => 1 - i / (pool.length - 1));

  const selected: Alternative[] = [];
  const taken = new Set<number>();
  while (selected.length < limit && taken.size < pool.length) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      if (taken.has(i)) continue;
      let maxSim = 0;
      for (const s of selected) {
        const sim = pairSimilarity(pool[i], s);
        if (sim > maxSim) maxSim = sim;
      }
      const score = MMR_LAMBDA * relevance[i] - (1 - MMR_LAMBDA) * maxSim;
      // 동점은 기존 순위가 앞선 쪽(작은 i) — 순회가 오름차순이라 > 비교로 보장된다
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    taken.add(bestIdx);
    selected.push(pool[bestIdx]);
  }
  return selected;
}

/**
 * 측정 전용 옵션 — 프로덕션 호출부는 전달하지 않는다.
 * (weights.ts SafetyTuning과 같은 취지의 주입 구멍: 별도 포팅으로 재현하면
 *  엔진과 어긋나므로, 실제 함수를 그대로 돌리되 한 축만 끈다.)
 */
export interface RecoOptions {
  /** false면 MMR 없이 2단계 정렬 결과를 그대로 자른다 (기본 true) */
  diversify?: boolean;
}

export function recommendAlternatives(
  target: PlaceWithSafety,
  candidates: PlaceWithSafety[],
  limit: number = DEFAULT_LIMIT,
  maxKm: number = MAX_DISTANCE_KM,
  opts: RecoOptions = {},
): Alternative[] {
  const preferIndoor =
    target.safety.weatherRisk >= RECO_WEATHER_RISK_INDOOR_THRESHOLD;

  const ranked: { alt: Alternative; rankScore: number }[] = [];
  for (const candidate of candidates) {
    if (candidate.contentId === target.contentId) continue;
    if (candidate.safety.score < target.safety.score + RECO_MIN_SCORE_GAIN)
      continue;

    const distanceKm = haversineKm(
      target.lat,
      target.lng,
      candidate.lat,
      candidate.lng,
    );
    if (distanceKm > maxKm) continue;

    let rankScore = categorySimilarity(target, candidate);
    if (preferIndoor && candidate.envType === "indoor") rankScore += INDOOR_BONUS;
    // 유형 관련성이 전혀 없는 후보는 제외 — "같은 유형의 대체지" 계약 유지
    if (rankScore === 0) continue;

    ranked.push({ alt: { ...candidate, distanceKm }, rankScore });
  }

  ranked.sort(
    (a, b) =>
      b.rankScore - a.rankScore ||
      b.alt.safety.score - a.alt.safety.score ||
      a.alt.distanceKm - b.alt.distanceKm,
  );

  const ordered = ranked.map((r) => r.alt);
  if (opts.diversify === false) return ordered.slice(0, limit);
  return mmrSelect(ordered.slice(0, limit * MMR_POOL_MULTIPLIER), limit);
}
