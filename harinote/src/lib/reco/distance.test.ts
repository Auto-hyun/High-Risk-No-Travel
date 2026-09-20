import { describe, expect, it } from "vitest";
import { haversineKm, roadKm, ROAD_DETOUR_FACTOR } from "@/lib/reco/distance";

describe("haversineKm", () => {
  it("동일 지점은 0", () => {
    expect(haversineKm(37.8813, 127.7298, 37.8813, 127.7298)).toBe(0);
  });

  it("위도 1도 차이는 약 111.2km", () => {
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.19, 0);
  });

  it("춘천~강릉은 직선거리 약 100km대 초반", () => {
    // 춘천시청(37.8813, 127.7298) ~ 강릉시청(37.7519, 128.8761)
    const d = haversineKm(37.8813, 127.7298, 37.7519, 128.8761);
    expect(d).toBeGreaterThan(95);
    expect(d).toBeLessThan(110);
  });

  it("인자 순서를 바꿔도 거리는 같다 (대칭성)", () => {
    const ab = haversineKm(37.8813, 127.7298, 37.7519, 128.8761);
    const ba = haversineKm(37.7519, 128.8761, 37.8813, 127.7298);
    expect(ab).toBeCloseTo(ba, 10);
  });
});

describe("roadKm — 도로거리 추정 (표시 전용)", () => {
  it("직선거리에 우회계수를 곱한다", () => {
    expect(roadKm(10)).toBeCloseTo(10 * ROAD_DETOUR_FACTOR, 5);
  });

  it("0은 0 — 거리 표시 유무 판정(distanceKm > 0)이 바뀌지 않는다", () => {
    expect(roadKm(0)).toBe(0);
  });

  it("소수 1자리로 반올림한다 (화면 표기와 같은 자리)", () => {
    expect(roadKm(12.34)).toBe(16);
  });

  it("직선거리보다 항상 크거나 같다 — 추정이 실제를 과소평가하지 않게", () => {
    for (const km of [0, 0.5, 3.7, 12.3, 49.9]) {
      expect(roadKm(km)).toBeGreaterThanOrEqual(Math.round(km * 10) / 10);
    }
  });

  it("단조 증가 — 먼 곳이 더 가깝게 표시되지 않는다", () => {
    const xs = [0, 1, 5, 10, 30, 50];
    for (let i = 1; i < xs.length; i++) {
      expect(roadKm(xs[i])).toBeGreaterThan(roadKm(xs[i - 1]));
    }
  });
});
