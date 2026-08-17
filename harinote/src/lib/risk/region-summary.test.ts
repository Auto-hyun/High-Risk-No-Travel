import { describe, expect, it } from "vitest";
import { summarizeRegions } from "@/lib/risk/region-summary";
import type { PlaceWithSafety } from "@/lib/datasource";
import type { PlaceEnvType } from "@/lib/tour/types";
import type { RiskFactor } from "@/lib/safety/types";

/** 요인 mock */
function f(key: string, points: number, value = 0, description = ""): RiskFactor {
  return {
    key: key as RiskFactor["key"],
    label: key,
    value,
    unit: "",
    threshold: 0,
    points,
    maxPoints: 40,
    level: "low",
    description,
  };
}

function mockPlace(
  sigunguCode: number | undefined,
  score: number,
  opts: { factors?: RiskFactor[]; envType?: PlaceEnvType; title?: string } = {},
): PlaceWithSafety {
  const { factors = [], envType = "outdoor_general", title = "곳" } = opts;
  return {
    sigunguCode,
    title,
    envType,
    safety: { score, factors },
  } as unknown as PlaceWithSafety;
}

describe("summarizeRegions", () => {
  it("18개 시군을 항상 반환한다 (빈 시군은 null)", () => {
    const result = summarizeRegions([]);
    expect(result).toHaveLength(18);
    for (const region of result) {
      expect(region.placeCount).toBe(0);
      expect(region.medianScore).toBeNull();
      expect(region.grade).toBeNull();
      expect(region.rank).toBeNull();
    }
  });

  it("대표지는 야외 풀의 중앙값에서 고른다 — 실내 점수가 끌어올리지 않는다", () => {
    // 실내가 다수이고 점수가 훨씬 높은 상황(산불 단계 실내 할인 등).
    // 전체 중앙값(90)으로 야외 풀에서 고르면 야외 최고점(50)이 대표가 되지만,
    // 야외 풀 중앙값(30)으로 고르면 실제 중앙 지점(30)이 대표가 된다
    const places = [
      ...[90, 92, 94, 96].map((s) => mockPlace(1, s, { envType: "indoor" })),
      mockPlace(1, 10, { title: "야외-하" }),
      mockPlace(1, 30, { title: "야외-중" }),
      mockPlace(1, 50, { title: "야외-상" }),
    ];
    const region = summarizeRegions(places).find((r) => r.sigunguCode === 1)!;
    expect(region.sampleName).toBe("야외-중");
    expect(region.medianScore).toBe(30);
  });

  it("순위는 점수 내림차순 · 동점은 같은 순위(1·2·2·4)", () => {
    const places = [
      mockPlace(1, 90),
      mockPlace(2, 80),
      mockPlace(3, 80),
      mockPlace(4, 70),
    ];
    const byCode = new Map(summarizeRegions(places).map((r) => [r.sigunguCode, r]));
    expect(byCode.get(1)!.rank).toBe(1);
    expect(byCode.get(2)!.rank).toBe(2);
    expect(byCode.get(3)!.rank).toBe(2);
    expect(byCode.get(4)!.rank).toBe(4);
    // 관광지 0곳인 시군은 순위 모집단에서 빠진다
    expect(byCode.get(1)!.rankedTotal).toBe(4);
    expect(byCode.get(5)!.rank).toBeNull();
  });

  it("시군별로 그룹핑하고 sigunguCode 없는 관광지는 제외", () => {
    const result = summarizeRegions([
      mockPlace(1, 80),
      mockPlace(2, 35),
      mockPlace(undefined, 10),
    ]);
    expect(result.find((r) => r.sigunguCode === 1)!.placeCount).toBe(1);
    expect(result.find((r) => r.sigunguCode === 2)!.placeCount).toBe(1);
    expect(result.reduce((s, r) => s + r.placeCount, 0)).toBe(2);
  });

  it("시군 점수·분해 = 대표 야외 관광지 (점수와 분해가 같은 장소에서 옴)", () => {
    const result = summarizeRegions([
      mockPlace(1, 76, { factors: [f("heat", 12), f("rain", 8), f("pm", 4)] }),
    ]);
    const g = result.find((r) => r.sigunguCode === 1)!;
    expect(g.medianScore).toBe(76); // 대표 장소 점수 그대로
    expect(g.grade).toBe("low");
    expect(g.factors.map((x) => x.key)).toEqual(["heat", "rain", "pm"]);
  });

  it("실내 제외 야외장소를 대표로 (실내로 강수 축소 방지)", () => {
    const result = summarizeRegions([
      mockPlace(1, 95, { factors: [f("rain", 3)], envType: "indoor" }),
      mockPlace(1, 60, { factors: [f("rain", 27)], envType: "outdoor_general" }),
    ]);
    const g = result.find((r) => r.sigunguCode === 1)!;
    expect(g.medianScore).toBe(60); // 야외장소 점수 (실내 95 아님)
    expect(g.factors.find((x) => x.key === "rain")!.points).toBe(27);
  });

  it("응급의료 설명에 시군 커버리지(골든타임 이내 %) 추가", () => {
    const result = summarizeRegions([
      mockPlace(1, 90, { factors: [f("medical", 1, 5, "응급실 5km")] }), // ≤10km
      mockPlace(1, 70, { factors: [f("medical", 3, 25, "응급실 25km")] }), // >10km
    ]);
    const med = result
      .find((r) => r.sigunguCode === 1)!
      .factors.find((x) => x.key === "medical")!;
    expect(med.description).toContain("50%"); // 2곳 중 1곳만 골든타임 이내
  });

  it("응급의료 감점은 시군 중앙값 — 대표가 병원 근처여도 시군 편차 반영(편향 방지)", () => {
    // 대표(병원 5km, 감점1)만 보면 안전해 보이나 시군엔 먼 곳(40km, 감점9)이 섞여 있다.
    const g = summarizeRegions([
      mockPlace(1, 90, { factors: [f("medical", 1, 5)], envType: "outdoor_general" }),
      mockPlace(1, 82, { factors: [f("medical", 9, 40)], envType: "outdoor_general" }),
    ]).find((r) => r.sigunguCode === 1)!;
    const med = g.factors.find((x) => x.key === "medical")!;
    expect(med.points).toBe(5); // 대표 1이 아니라 시군 중앙값 median([1,9])=5
    expect(g.medianScore).toBe(86); // 대표 90 − (5−1) 집계 차이
  });

  it("산사태 발령은 대표 관광지 값이 그대로 시군 점수에 들어간다 — 발령은 시군 단위", () => {
    // 공식 발령은 시군 전역에 걸리므로 관광지마다 같은 단계다(노출 비율 집계 없음)
    const g = summarizeRegions([
      mockPlace(1, 55, { factors: [f("landslide", 45, 1)], envType: "outdoor_general" }),
      mockPlace(1, 55, { factors: [f("landslide", 45, 1)], envType: "outdoor_mountain" }),
    ]).find((r) => r.sigunguCode === 1)!;
    const ls = g.factors.find((x) => x.key === "landslide")!;
    expect(ls.points).toBe(45);
    expect(g.medianScore).toBe(55);
    expect(g.landslideAlert).toBe(1);
  });

  it("경보 시군은 배지 단계가 2다", () => {
    const g = summarizeRegions([
      mockPlace(2, 20, { factors: [f("landslide", 80, 2)], envType: "outdoor_general" }),
    ]).find((r) => r.sigunguCode === 2)!;
    expect(g.landslideAlert).toBe(2);
    expect(g.medianScore).toBe(20);
  });

  it("발령이 없으면 산사태 요인도 배지도 없다", () => {
    const g = summarizeRegions([
      mockPlace(3, 90, { factors: [f("heat", 10)], envType: "outdoor_general" }),
    ]).find((r) => r.sigunguCode === 3)!;
    expect(g.factors.some((x) => x.key === "landslide")).toBe(false);
    expect(g.landslideAlert).toBe(0);
  });
});
