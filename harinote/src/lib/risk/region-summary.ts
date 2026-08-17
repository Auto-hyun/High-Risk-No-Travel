/**
 * 시군별 안전점수 집계 — /map 시군 위험 지도의 데이터 소스.
 *
 * 대표값은 평균이 아니라 **중앙값**을 쓴다: 시군 안에 극단 점수(고립 산악지 등)가
 * 섞여도 "이 시군의 오늘 분위기"가 덜 왜곡되도록.
 * 등급 판정은 새 임계값 없이 기존 gradeForScore(weights.ts)를 그대로 재사용한다.
 *
 * getRegionSummaries는 datasource(서버 전용)를 호출하므로 이 모듈도 서버 전용.
 * 순수 함수 summarizeRegions는 테스트에서 직접 호출한다.
 */
import type { Profile, RiskFactor, RiskLevel } from "@/lib/safety/types";
import { gradeForScore, levelForPoints, MEDICAL } from "@/lib/safety/weights";
import { SIGUNGU_SEATS } from "@/lib/risk/regions";
import {
  getPlacesWithSafety,
  getPlacesWithSafetyOnDate,
  getPlacesWithSafetyOnRange,
  type PlaceWithSafety,
} from "@/lib/datasource";

export interface RegionSummary {
  sigunguCode: number;
  name: string;
  lat: number;
  lng: number;
  /**
   * 시군 대표 안전점수 — **야외 관광지 기준**이다(실내는 기상 영향이 낮아 제외).
   *
   * 야외 풀의 중앙값에 가장 가까운 관광지를 대표로 삼고, 그 점수에서 응급의료(시군 중앙값)만
   * 시군 집계로 보정한다. 산사태는 시군 단위 공식 발령이라 대표 관광지 값이 곧 시군 값이다.
   * 0곳이면 null.
   *
   * ⚠ 목록 화면은 실내(음식점·카페)를 포함하므로, 실내·야외 점수가 벌어지는 날에는
   *   이 값이 목록 상단보다 낮게 보인다. 같은 시군을 다른 모집단으로 보는 것이지 불일치가 아니다.
   */
  medianScore: number | null;
  /** 대표 점수의 등급(gradeForScore) — 관광지 0곳이면 null */
  grade: RiskLevel | null;
  placeCount: number;
  /**
   * "이 점수가 왜 나왔나" 요인 분해 — 날씨·산불·산사태는 대표 관광지(sampleName) 값,
   * 응급의료만 시군 중앙값. 0곳이면 []. 점수(medianScore)=요인 감점 합 유지.
   */
  factors: RiskFactor[];
  /** factors의 출처가 된 대표 관광지 이름 (없으면 null) */
  sampleName: string | null;
  /** 시군 산사태 예보발령 단계(0 없음·1 주의보·2 경보) — 배지 라벨용. */
  landslideAlert: 0 | 1 | 2;
  /**
   * 안전점수 기준 시군 순위(1위 = 가장 안전). 동점은 같은 순위(1·2·2·4). 0곳이면 null.
   *
   * 등급만으로는 지도가 정보를 못 준다 — 계절에 따라 18개 시군이 통째로 같은 등급에
   * 들어가는 날이 흔하다(실측: 5개 시나리오 중 3개). 절대 등급과 별개로 "강원 안에서
   * 상대적으로 어디쯤인가"를 읽을 수 있어야 시군 비교라는 지도의 목적이 산다.
   */
  rank: number | null;
  /** 순위 모집단 크기 = 점수가 있는 시군 수 (관광지 0곳인 시군 제외) */
  rankedTotal: number;
}

/** 정렬된 배열의 중앙값 — 짝수 개면 가운데 두 값 평균을 반올림 */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * 관광지 배열 → 강원 18개 시군 요약 (sigunguCode 오름차순).
 * sigunguCode가 없거나 SIGUNGU_SEATS에 없는 관광지는 제외.
 * 관광지 0곳인 시군도 SIGUNGU_SEATS 기준으로 포함한다 (medianScore/grade = null).
 */
export function summarizeRegions(places: PlaceWithSafety[]): RegionSummary[] {
  const placesByCode = new Map<number, PlaceWithSafety[]>();
  for (const place of places) {
    const code = place.sigunguCode;
    if (code === undefined || !(code in SIGUNGU_SEATS)) continue;
    const arr = placesByCode.get(code) ?? [];
    arr.push(place);
    placesByCode.set(code, arr);
  }

  const sorted = Object.keys(SIGUNGU_SEATS)
    .map(Number)
    .map((code) => {
      const seat = SIGUNGU_SEATS[code];
      const group = placesByCode.get(code) ?? [];
      const scores = group.map((p) => p.safety.score).sort((a, b) => a - b);

      // 시군 대표 = 실내 제외 야외장소 중 점수가 중앙값에 가장 가까운 곳(medoid).
      // 검증1 하이브리드(da-methodologist): 날씨·산불·산사태는 대표 장소값, 장소 편차가
      // 큰 응급의료만 시군 중앙값으로 보정한다(대표 1곳이 우연히 병원 근처라 안전해 보이는
      // 편향 방지). 점수=요인 감점 합 유지.
      let medianScore: number | null = null;
      let grade: RiskLevel | null = null;
      let factors: RiskFactor[] = [];
      let sampleName: string | null = null;
      let landslideAlert: 0 | 1 | 2 = 0;
      if (scores.length > 0) {
        const general = group.filter((p) => p.envType === "outdoor_general");
        const outdoor = group.filter((p) => p.envType !== "indoor");
        const pool = general.length ? general : outdoor.length ? outdoor : group;
        // 중앙값과 대표지를 **같은 모집단**에서 구한다. 전체(실내 포함) 중앙값으로 야외 풀에서
        // 고르면, 실내·야외 점수가 벌어질 때 중앙값이 풀 전체보다 위로 올라가 대표지가
        // "야외 최고점"으로 퇴화한다 — 산불 3단계 실측에서 10/18 시군이 그랬다.
        const anchor = median(pool.map((p) => p.safety.score).sort((a, b) => a - b));
        const rep = pool.reduce((best, p) =>
          Math.abs(p.safety.score - anchor) < Math.abs(best.safety.score - anchor)
            ? p
            : best,
        );
        const repFactors = rep.safety.factors ?? [];
        sampleName = rep.title ?? null;

        // 응급의료 — 시군 관광지 감점의 중앙값(대표 1곳 대신) + 골든타임 커버리지(%).
        const medPts = group
          .map((p) => p.safety.factors?.find((f) => f.key === "medical")?.points)
          .filter((v): v is number => v !== undefined)
          .sort((a, b) => a - b);
        const medKms = group
          .map((p) => p.safety.factors?.find((f) => f.key === "medical")?.value)
          .filter((v): v is number => v !== undefined)
          .sort((a, b) => a - b);
        const repMedical = repFactors.find((f) => f.key === "medical");
        const newMedPts = medPts.length ? median(medPts) : (repMedical?.points ?? 0);
        const newMedKm = medKms.length ? median(medKms) : (repMedical?.value ?? 0);
        const within =
          medKms.length > 0
            ? Math.round(
                (medKms.filter((k) => k <= MEDICAL.NEAR_KM).length / medKms.length) * 100,
              )
            : null;

        // 산사태 — 공식 발령은 시군 단위라 관광지마다 같은 단계다. 점수는 대표 관광지 값이
        // 그대로 흐르고(별도 집계 없음), 배지용 단계만 최대값으로 집계한다.
        for (const p of group) {
          const lv = Math.round(
            (p.safety.factors?.find((f) => f.key === "landslide")?.value ?? 0) as number,
          );
          if (lv > landslideAlert) landslideAlert = Math.min(2, lv) as 0 | 1 | 2;
        }

        // 점수 = 대표 점수 − (의료 시군집계 차이). 100−요인 감점 합과 일치.
        const delta = newMedPts - (repMedical?.points ?? 0);
        medianScore = Math.max(0, Math.min(100, rep.safety.score - delta));
        grade = gradeForScore(medianScore);

        // 요인 분해 — 날씨·산불·산사태는 대표장소 값, 의료만 시군 중앙값으로 교체.
        factors = repFactors
          .map((f) =>
            f.key === "medical"
              ? {
                  ...f,
                  value: newMedKm,
                  points: newMedPts,
                  level: levelForPoints(newMedPts, MEDICAL.MAX_POINTS),
                  description: `최근접 응급의료기관 시군 중앙값 ${newMedKm}km${
                    within !== null
                      ? ` · 관광지 ${within}%가 골든타임(${MEDICAL.NEAR_KM}km) 이내`
                      : ""
                  }`,
                }
              : f,
          );
      }
      return {
        sigunguCode: code,
        name: seat.name,
        lat: seat.lat,
        lng: seat.lng,
        medianScore,
        grade,
        placeCount: scores.length,
        factors,
        sampleName,
        landslideAlert,
      };
    })
    // 안전점수 높은 시군부터 (데이터 없는 곳은 맨 뒤)
    .sort((a, b) => (b.medianScore ?? -1) - (a.medianScore ?? -1));

  // 정렬 후에 순위를 붙인다. 동점은 같은 순위(1·2·2·4) — 점수가 정수라 동점이 흔하다
  const rankedTotal = sorted.filter((r) => r.medianScore !== null).length;
  let prevScore: number | null = null;
  let prevRank = 0;
  return sorted.map((r, i) => {
    if (r.medianScore === null) return { ...r, rank: null, rankedTotal };
    const rank = r.medianScore === prevScore ? prevRank : i + 1;
    prevScore = r.medianScore;
    prevRank = rank;
    return { ...r, rank, rankedTotal };
  });
}

/**
 * 전체 관광지의 점수를 시군별로 요약 — 서버 전용.
 * profile·dateISO를 주면 그 조건의 점수로 지도가 반응한다 (홈 날짜 스테퍼).
 * endISO까지 주면 기간 모드 — 기간 중 최악일 대표점수 기준.
 */
export async function getRegionSummaries(
  profile: Profile = "default",
  dateISO?: string,
  endISO?: string,
): Promise<RegionSummary[]> {
  const places = dateISO
    ? endISO
      ? await getPlacesWithSafetyOnRange(profile, dateISO, endISO)
      : await getPlacesWithSafetyOnDate(profile, dateISO)
    : await getPlacesWithSafety(undefined, profile);
  return summarizeRegions(places);
}
