/**
 * 추천 품질 하네스 가드 — 발표에서 인용하는 수치를 CI가 지킨다.
 *
 * 안전 민감도 하네스(safety-sensitivity.test.ts)와 같은 취지다: 문서에만 숫자가 있고
 * 재현 코드가 없는 상태로 돌아가지 않게 막는다. 여기서 지키는 성질은 두 가지 —
 *   ① 다양성 재랭킹이 **하드 제약을 건드리지 않는다** (순서만 바꾼다)
 *   ② 다양성이 **관련도를 크게 희생하지 않는다** (λ 배분이 무너지면 걸린다)
 */
import { describe, expect, it } from "vitest";
import { runAll, SCENARIOS, type RecoMetrics } from "./reco-quality";

const results = runAll();
const get = (scenario: string, mode: RecoMetrics["mode"]) =>
  results.find((r) => r.scenario === scenario && r.mode === mode)!;

describe("측정 설계", () => {
  it("시나리오 × 모드 전 조합을 잰다", () => {
    expect(results).toHaveLength(SCENARIOS.length * 2);
  });

  it("target 표본이 선언한 크기다 — 표본 변경은 의도적이어야 한다", () => {
    for (const r of results) expect(r.targets).toBe(155);
  });

  it("기상적으로 모순인 시나리오(호우 + 산불 고단계)를 만들지 않는다", () => {
    // 산불은 건조, 호우는 강우에서 발생한다(weights.ts LANDSLIDE 주석)
    const bad = SCENARIOS.filter(
      (s) => (s.input.rainMm ?? 0) >= 30 && s.input.forestFireLevel >= 3,
    );
    expect(bad).toHaveLength(0);
  });
});

describe("하드 제약 — 재랭킹이 자격 판정을 건드리지 않는다", () => {
  it("제약 위반이 한 건도 없다 (반경·최소개선·자기제외)", () => {
    for (const r of results) {
      expect(r.violations, `${r.scenario}/${r.mode} 위반`).toBe(0);
    }
  });

  it("MMR은 추천 건수를 바꾸지 않는다 — 고르는 방식만 다르다", () => {
    for (const s of SCENARIOS) {
      const b = get(s.key, "baseline");
      const m = get(s.key, "mmr");
      expect(m.fillRate, `${s.key} 추천가능률`).toBeCloseTo(b.fillRate, 10);
      expect(m.meanCount, `${s.key} 평균 건수`).toBeCloseTo(b.meanCount, 10);
    }
  });
});

describe("다양성 — 켜면 나아지고, 대가는 작다", () => {
  it("ILD가 끈 것보다 낮아지지 않는다", () => {
    for (const s of SCENARIOS) {
      expect(get(s.key, "mmr").ild, `${s.key} ILD`).toBeGreaterThanOrEqual(
        get(s.key, "baseline").ild,
      );
    }
  });

  it("'목록 전체가 같은 분류'가 늘지 않는다", () => {
    for (const s of SCENARIOS) {
      expect(
        get(s.key, "mmr").monoCat3Rate,
        `${s.key} 동일분류 독식률`,
      ).toBeLessThanOrEqual(get(s.key, "baseline").monoCat3Rate);
    }
  });

  it("'목록 전체가 같은 동네'가 늘지 않는다", () => {
    for (const s of SCENARIOS) {
      expect(
        get(s.key, "mmr").monoNeighborhoodRate,
        `${s.key} 동일동네 독식률`,
      ).toBeLessThanOrEqual(get(s.key, "baseline").monoNeighborhoodRate);
    }
  });

  it("안전점수 개선폭을 2점 넘게 희생하지 않는다 — λ 배분이 무너지면 걸린다", () => {
    // 하한선이다. 실측은 오히려 소폭 상승한다(analysis/33_reco_quality_result.md) —
    // rankScore가 지배하는 정렬 아래에 점수가 더 높은 후보가 깔려 있기 때문.
    for (const s of SCENARIOS) {
      const drop = get(s.key, "baseline").meanGain - get(s.key, "mmr").meanGain;
      expect(drop, `${s.key} 개선폭 하락`).toBeLessThanOrEqual(2);
    }
  });
});
