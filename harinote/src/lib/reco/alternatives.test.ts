/**
 * 안전 대체지 추천 v1 테스트.
 * 좌표 참고: 위도 0.1도 ≈ 11.1km — target(37.8, 128.0) 기준 0.25도(≈27.8km)까지 30km 이내.
 */
import { describe, expect, it } from "vitest";
import type { PlaceWithSafety } from "@/lib/datasource";
import type { RiskBreakdown } from "@/lib/safety/types";
import {
  MMR_LAMBDA,
  recommendAlternatives,
} from "@/lib/reco/alternatives";

function makeSafety(score: number, weatherRisk = 0): RiskBreakdown {
  return {
    score,
    grade: "low",
    profile: "default",
    factors: [],
    weatherRisk,
    disasterRisk: 0,
    medicalRisk: 0,
  };
}

let nextId = 1;

function makePlace(overrides: Partial<PlaceWithSafety> = {}): PlaceWithSafety {
  return {
    contentId: nextId++,
    contentTypeId: 12,
    title: "테스트 관광지",
    addr: "강원특별자치도",
    cat1: "A02",
    cat2: "A0202",
    cat3: "A02020300",
    lng: 128.0,
    lat: 37.8,
    envType: "outdoor_general",
    safety: makeSafety(80),
    ...overrides,
  };
}

/** 기본 target: 점수 70, 기상 감점 0 */
const target = makePlace({ contentId: 999999, safety: makeSafety(70) });

describe("recommendAlternatives — 필터", () => {
  it("자기 자신(contentId 동일)은 제외", () => {
    const self = makePlace({
      contentId: target.contentId,
      safety: makeSafety(95),
    });
    expect(recommendAlternatives(target, [self])).toEqual([]);
  });

  it("30km 초과 후보는 제외, 이내 후보는 포함", () => {
    const near = makePlace({ lat: 37.9 }); // ≈11.1km
    const far = makePlace({ lat: 38.2 }); // ≈44.5km
    const result = recommendAlternatives(target, [near, far]);
    expect(result.map((r) => r.contentId)).toEqual([near.contentId]);
  });

  it("distanceKm이 실제 거리로 채워진다", () => {
    const near = makePlace({ lat: 37.9 });
    const [alt] = recommendAlternatives(target, [near]);
    expect(alt.distanceKm).toBeCloseTo(11.1, 0);
  });

  it("안전점수가 target+5 미만이면 제외", () => {
    const notEnough = makePlace({ safety: makeSafety(74) }); // +4
    expect(recommendAlternatives(target, [notEnough])).toEqual([]);
  });

  it("안전점수가 정확히 target+5이면 포함", () => {
    const enough = makePlace({ safety: makeSafety(75) }); // +5
    expect(recommendAlternatives(target, [enough])).toHaveLength(1);
  });

  it("조건을 만족하는 후보가 없으면 빈 배열", () => {
    expect(recommendAlternatives(target, [])).toEqual([]);
  });
});

describe("recommendAlternatives — 카테고리 유사도 정렬", () => {
  it("cat3 일치가 cat2 일치보다 우선", () => {
    // cat2 일치 후보가 점수는 더 높아도 cat3 일치가 앞선다
    const cat2Only = makePlace({ cat3: "A02020400", safety: makeSafety(95) });
    const cat3Match = makePlace({ safety: makeSafety(80) });
    const result = recommendAlternatives(target, [cat2Only, cat3Match]);
    expect(result.map((r) => r.contentId)).toEqual([
      cat3Match.contentId,
      cat2Only.contentId,
    ]);
  });

  it("cat2 일치가 contentTypeId 일치보다 우선", () => {
    const typeOnly = makePlace({
      cat2: "A0101",
      cat3: "A01010100",
      safety: makeSafety(95),
    });
    const cat2Match = makePlace({ cat3: "A02020400", safety: makeSafety(80) });
    const result = recommendAlternatives(target, [typeOnly, cat2Match]);
    expect(result.map((r) => r.contentId)).toEqual([
      cat2Match.contentId,
      typeOnly.contentId,
    ]);
  });

  it("유형 관련성 0점(카테고리·유형 완전 불일치) 후보는 제외된다", () => {
    const noMatch = makePlace({
      contentTypeId: 39,
      cat1: "A05",
      cat2: "A0502",
      cat3: "A05020100",
      safety: makeSafety(95),
    });
    const typeMatch = makePlace({
      cat2: "A0101",
      cat3: "A01010100",
      safety: makeSafety(80),
    });
    const result = recommendAlternatives(target, [noMatch, typeMatch]);
    // UI가 "같은 유형의 대체지"를 약속하므로 무관 유형은 안전점수가 높아도 제외
    expect(result.map((r) => r.contentId)).toEqual([typeMatch.contentId]);
  });
});

describe("recommendAlternatives — 실내 보정", () => {
  // 실내 후보: contentTypeId만 일치(1점) + 실내 보정(+2) = 3점
  // 야외 후보: cat2 일치(2점)
  const indoor = makePlace({
    cat2: "A0101",
    cat3: "A01010100",
    envType: "indoor",
    safety: makeSafety(80),
  });
  const outdoorCat2 = makePlace({ cat3: "A02020400", safety: makeSafety(80) });

  it("target 기상 감점이 크면(weatherRisk >= 15) 실내 후보 우대", () => {
    const rainyTarget = { ...target, safety: makeSafety(70, 15) };
    const result = recommendAlternatives(rainyTarget, [outdoorCat2, indoor]);
    expect(result.map((r) => r.contentId)).toEqual([
      indoor.contentId,
      outdoorCat2.contentId,
    ]);
  });

  it("기상 감점이 작으면(weatherRisk < 15) 실내 보정 없음", () => {
    const clearTarget = { ...target, safety: makeSafety(70, 14) };
    const result = recommendAlternatives(clearTarget, [indoor, outdoorCat2]);
    expect(result.map((r) => r.contentId)).toEqual([
      outdoorCat2.contentId,
      indoor.contentId,
    ]);
  });
});

describe("recommendAlternatives — 동점 처리·limit", () => {
  it("유사도 동점이면 안전점수 내림차순", () => {
    const lower = makePlace({ safety: makeSafety(80) });
    const higher = makePlace({ safety: makeSafety(90) });
    const result = recommendAlternatives(target, [lower, higher]);
    expect(result.map((r) => r.contentId)).toEqual([
      higher.contentId,
      lower.contentId,
    ]);
  });

  it("유사도·점수 동점이면 거리 오름차순", () => {
    const far = makePlace({ lat: 38.0 }); // ≈22.2km
    const near = makePlace({ lat: 37.9 }); // ≈11.1km
    const result = recommendAlternatives(target, [far, near]);
    expect(result.map((r) => r.contentId)).toEqual([
      near.contentId,
      far.contentId,
    ]);
  });

  it("기본 limit은 4", () => {
    const many = Array.from({ length: 8 }, () => makePlace());
    expect(recommendAlternatives(target, many)).toHaveLength(4);
  });

  it("limit 지정 시 해당 개수만 반환", () => {
    const many = Array.from({ length: 8 }, () => makePlace());
    expect(recommendAlternatives(target, many, 2)).toHaveLength(2);
  });
});

describe("recommendAlternatives — 다양성 재랭킹(MMR)", () => {
  /** 같은 동네(37.9, 128.0) 같은 소분류로 뭉친 후보 n개 */
  const cluster = (n: number, score: number) =>
    Array.from({ length: n }, () =>
      makePlace({ lat: 37.9, lng: 128.0, safety: makeSafety(score) }),
    );

  it("1순위는 MMR을 켜도 끈 것과 같다 — 기준을 바꾸지 않는다", () => {
    const pool = [
      ...cluster(5, 90),
      makePlace({ lat: 37.7, lng: 127.8, cat3: "A02020400", safety: makeSafety(82) }),
    ];
    const on = recommendAlternatives(target, pool);
    const off = recommendAlternatives(target, pool, 4, 30, { diversify: false });
    expect(on[0].contentId).toBe(off[0].contentId);
  });

  it("한 군집이 목록을 독식하지 않는다 — 다른 동네가 끼어든다", () => {
    // 같은 좌표·같은 소분류 후보가 상위를 메우고, 관련도가 한 칸 아래인
    // "다른 동네" 후보가 하나 있는 상황 (MMR 풀 = limit 4 × 5 = 20곳)
    const far = makePlace({
      lat: 37.9,
      lng: 128.28, // 군집에서 ≈24.6km, target에서 ≈27km (반경 30km 안)
      safety: makeSafety(91),
    });
    const pool = [
      ...cluster(4, 95),
      far,
      ...Array.from({ length: 15 }, (_, i) =>
        makePlace({ lat: 37.9, lng: 128.0, safety: makeSafety(90 - i) }),
      ),
    ];

    // MMR 없이는 상위 4칸을 한 군집이 전부 차지한다
    const off = recommendAlternatives(target, pool, 4, 30, { diversify: false });
    expect(off.map((r) => r.contentId)).not.toContain(far.contentId);

    // MMR을 켜면 닮지 않은 후보가 들어온다
    const on = recommendAlternatives(target, pool);
    expect(on.map((r) => r.contentId)).toContain(far.contentId);
  });

  it("하드 제약은 재랭킹 뒤에도 그대로다 — 반경·최소개선·유형 관련성", () => {
    const pool = [
      ...cluster(6, 88),
      makePlace({ lat: 38.4, safety: makeSafety(99) }), // 반경 밖
      makePlace({ lat: 37.85, safety: makeSafety(72) }), // +2점 (최소개선 미달)
      makePlace({
        lat: 37.85,
        contentTypeId: 39,
        cat1: "A05",
        cat2: "A0502",
        cat3: "A05020100",
        safety: makeSafety(99),
      }), // 유형 관련성 0
    ];
    for (const alt of recommendAlternatives(target, pool)) {
      expect(alt.distanceKm).toBeLessThanOrEqual(30);
      expect(alt.safety.score).toBeGreaterThanOrEqual(target.safety.score + 5);
      expect(alt.contentTypeId).toBe(target.contentTypeId);
    }
  });

  it("limit과 중복 없음은 유지된다", () => {
    const result = recommendAlternatives(target, cluster(12, 85));
    expect(result).toHaveLength(4);
    expect(new Set(result.map((r) => r.contentId)).size).toBe(4);
  });

  it("결정적이다 — 같은 입력을 두 번 넣으면 같은 순서", () => {
    const pool = [...cluster(4, 91), ...cluster(4, 86)];
    const a = recommendAlternatives(target, pool).map((r) => r.contentId);
    const b = recommendAlternatives(target, pool).map((r) => r.contentId);
    expect(a).toEqual(b);
  });

  it("λ는 관련도 우위 구간(0.5~1)에 있다 — 다양성이 순위를 뒤집지 않게", () => {
    expect(MMR_LAMBDA).toBeGreaterThan(0.5);
    expect(MMR_LAMBDA).toBeLessThan(1);
  });
});
