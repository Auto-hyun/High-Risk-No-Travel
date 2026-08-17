/**
 * 안전 점수 엔진 테스트 — 쾌적층(TCI) − 안전층 모델.
 * SafetyScore = TCI(체감·강수·미먼·바람) − 안전(산불·산사태·의료) − 이동. 재난경보급은 감점 앵커로 총점 보장.
 */
import { describe, expect, it } from "vitest";
import { computeSafetyScore, ALERT_BAND_CAP } from "@/lib/safety/score";
import {
  ENV_WEIGHT,
  FOREST_FIRE,
  HEAVY_RAIN,
  LANDSLIDE,
  gradeForScore,
} from "@/lib/safety/weights";
import type {
  Profile,
  RiskBreakdown,
  RiskFactorKey,
  RiskInput,
} from "@/lib/safety/types";
import type { PlaceEnvType } from "@/lib/tour/types";

/** 이상적 봄날 기본 입력 (체감 21℃·무강수·청정·미풍·응급실 5km) */
const CLEAR: RiskInput = {
  tempC: 21,
  rainProbPct: 10,
  windMs: 2,
  pm25: 10,
  forestFireLevel: 1,
  emergencyRoomKm: 5,
};

function run(
  input: Partial<RiskInput>,
  envType: PlaceEnvType = "outdoor_general",
  profile: Profile = "default",
): RiskBreakdown {
  return computeSafetyScore({ ...CLEAR, ...input }, { envType }, profile);
}

function factor(b: RiskBreakdown, key: RiskFactorKey) {
  const f = b.factors.find((f) => f.key === key);
  if (!f) throw new Error(`factor ${key} 없음`);
  return f;
}

describe("computeSafetyScore — 기본/구조", () => {
  it("이상적 봄날은 90점 이상, grade low", () => {
    const b = run({});
    expect(b.score).toBeGreaterThanOrEqual(90);
    expect(b.grade).toBe("low");
  });

  it("체감온도/강수·바람/미세먼지/산불/응급의료 요인은 항상 포함", () => {
    const keys = run({}).factors.map((f) => f.key);
    for (const k of ["heat", "rain", "wind", "pm", "forest_fire", "medical"]) {
      expect(keys).toContain(k);
    }
  });

  it("모든 요인 points는 0 이상의 정수", () => {
    const b = run(
      { tempC: 36, apparentTempC: 38, rainProbPct: 85, rainMm: 70, windMs: 15, pm25: 80, forestFireLevel: 3, emergencyRoomKm: 35 },
      "outdoor_water",
      "with_kids",
    );
    for (const f of b.factors) {
      expect(Number.isInteger(f.points)).toBe(true);
      expect(f.points).toBeGreaterThanOrEqual(0);
    }
  });

  it("체감온도(apparentTempC)가 있으면 그것으로 열쾌적 평가 (건구 tempC 대신)", () => {
    // 건구 30℃지만 체감 36℃ → 무더위로 큰 감점
    const dry = factor(run({ tempC: 30, apparentTempC: 30 }), "heat").points;
    const humid = factor(run({ tempC: 30, apparentTempC: 36 }), "heat").points;
    expect(humid).toBeGreaterThan(dry);
  });
});

describe("쾌적층(TCI) — 계절 패턴", () => {
  it("한여름 무더위(체감35)는 봄날보다 점수 크게 낮다", () => {
    const spring = run({ tempC: 21 }).score;
    const summer = run({ tempC: 35 }).score;
    expect(summer).toBeLessThan(spring - 20);
  });

  it("체감온도 오를수록 heat 감점 증가(26→31→35)", () => {
    const p26 = factor(run({ tempC: 26 }), "heat").points;
    const p31 = factor(run({ tempC: 31 }), "heat").points;
    const p35 = factor(run({ tempC: 35 }), "heat").points;
    expect(p31).toBeGreaterThan(p26);
    expect(p35).toBeGreaterThan(p31);
  });

  it("실내는 같은 무더위에 감점 작다(×0.3) → 점수 높다", () => {
    const outdoor = run({ tempC: 35 });
    const indoor = run({ tempC: 35 }, "indoor");
    expect(factor(indoor, "heat").points).toBeLessThan(factor(outdoor, "heat").points);
    expect(indoor.score).toBeGreaterThan(outdoor.score);
  });

  it("계곡(outdoor_water)은 비 올 때 강수 감점 크다(강수 ×1.5)", () => {
    const general = factor(run({ rainMm: 20, rainProbPct: 80 }), "rain").points;
    const water = factor(run({ rainMm: 20, rainProbPct: 80 }, "outdoor_water"), "rain").points;
    expect(water).toBeGreaterThan(general);
  });

  it("강수·바람은 별개 요인(KTCI 가중 분리) — rain_wind 합쳐진 요인 없음", () => {
    const keys = run({ rainProbPct: 80, windMs: 12 }).factors.map((f) => f.key);
    expect(keys).toContain("rain");
    expect(keys).toContain("wind");
    expect(keys).not.toContain("rain_wind");
  });

  it("흐린 날 일조 감점은 강수확률 높으면 완화(이중 페널티 방지)", () => {
    // 흐림(sunHours 1) 고정, 강수확률만 달리 — 낮으면 감점 유지, 높으면 0
    const dry = factor(run({ sunHours: 1, rainProbPct: 10 }), "sun").points;
    const mid = factor(run({ sunHours: 1, rainProbPct: 45 }), "sun").points;
    const wet = factor(run({ sunHours: 1, rainProbPct: 80 }), "sun").points;
    expect(dry).toBeGreaterThan(0); // 비 안 오는 흐림 → 일조 감점 유효
    expect(mid).toBeLessThan(dry); // 30~59% → 절반
    expect(wet).toBe(0); // ≥60% → 강수 축이 담당, 일조 중복 제거
  });

  // 민감군은 배율이 아니라 곡선이다 — NOTE_민감층_임계값.md 채택 스펙:
  // 좋음 0=0 · 보통 3→5 · 나쁨 8→12 · 매우나쁨 15=15 (양 끝은 같고 중간만 벌어진다)
  it("미세먼지 민감층(with_kids) 차등은 보통·나쁨 구간에서 생긴다", () => {
    const pm = (pm25: number, profile: Profile = "default") =>
      factor(run({ pm25 }, "outdoor_general", profile), "pm").points;
    // 보통(≤35)·나쁨(≤75) — 같은 농도에서 민감군이 더 깎인다
    expect(pm(30, "with_kids")).toBeGreaterThan(pm(30));
    expect(pm(60, "with_kids")).toBeGreaterThan(pm(60));
  });

  it("미세먼지 좋음·매우나쁨은 프로필과 무관 — 스펙상 양 끝은 동일", () => {
    const pm = (pm25: number, profile: Profile = "default") =>
      factor(run({ pm25 }, "outdoor_general", profile), "pm").points;
    expect(pm(10)).toBe(0); // 좋음 — 둘 다 감점 0
    expect(pm(10, "with_kids")).toBe(0);
    expect(pm(120)).toBeGreaterThan(0); // 매우나쁨 — 둘 다 축 상한
    expect(pm(120, "with_kids")).toBe(pm(120));
  });

  it("민감층 미세먼지 감점이 축 배점을 넘지 않는다 — 배율 방식의 결함", () => {
    // 배율(×1.4)은 매우나쁨에서 배점을 초과해 표시 상한까지 부풀려야 했다.
    // 곡선은 배점 안에서 움직이므로 게이지가 100%를 넘지 않는다
    const f = factor(run({ pm25: 120 }, "outdoor_general", "with_kids"), "pm");
    expect(f.points).toBeLessThanOrEqual(f.maxPoints);
    // 배점은 프로필과 무관하게 KTCI 가중에서만 나온다
    expect(f.maxPoints).toBe(factor(run({ pm25: 120 }), "pm").maxPoints);
  });

  it("비 오면 같은 조건보다 점수 하락", () => {
    const dry = run({ rainMm: 0 }).score;
    const wet = run({ rainMm: 20, rainProbPct: 80 }).score;
    expect(wet).toBeLessThan(dry);
  });
});

describe("안전층 — 산불·산사태·응급의료", () => {
  it("산불 1단계는 감점 0, 3단계는 감점 발생", () => {
    expect(factor(run({ forestFireLevel: 1 }), "forest_fire").points).toBe(0);
    expect(factor(run({ forestFireLevel: 3 }), "forest_fire").points).toBeGreaterThan(0);
  });

  it("산불 단계가 여행 등급을 보장 — 높음→주의, 매우높음→방문자제(지형 무관)", () => {
    // 감점(0/15/45/80)이 100점 만점 기준이라 그 자체가 등급을 강제한다
    expect(run({ forestFireLevel: 3 }).grade).toBe("moderate"); // 주의
    expect(run({ forestFireLevel: 4 }).grade).toBe("high"); // 방문 자제
    expect(run({ forestFireLevel: 4 }, "indoor").grade).toBe("high"); // 실내도 대피급
  });

  it("산불 3단계: 실내는 환경 할인, 산악은 가중 미적용(설계값 보류)", () => {
    // 산불위험은 시군 공통값이라 실내에 그대로 먹이면 도심 음식점이 산지와 같은 감점을 받는다
    const general = factor(run({ forestFireLevel: 3 }), "forest_fire").points;
    const indoor = factor(run({ forestFireLevel: 3 }, "indoor"), "forest_fire").points;
    const mountain = factor(run({ forestFireLevel: 3 }, "outdoor_mountain"), "forest_fire").points;
    expect(indoor).toBeLessThan(general);
    expect(mountain).toBe(general); // 산악 1.3 가중은 실증 보정 전까지 미적용
  });

  it("산불 4단계는 실내도 할인 없음 — 통제·대피급", () => {
    const general = factor(run({ forestFireLevel: 4 }), "forest_fire").points;
    expect(factor(run({ forestFireLevel: 4 }, "indoor"), "forest_fire").points).toBe(general);
  });

  it("한파: tminC 없으면 축 비활성, 한파주의보급이면 요인 발생", () => {
    expect(run({}).factors.some((f) => f.key === "cold")).toBe(false);
    // -5℃ 초과는 감점 0이라 요인을 만들지 않는다 (여름에 빈 막대가 서지 않게)
    expect(run({ tminC: -2 }).factors.some((f) => f.key === "cold")).toBe(false);
    expect(factor(run({ tminC: -13 }), "cold").points).toBeGreaterThan(0);
  });

  it("한파는 쾌적층 열쾌적과 별개 축 — 최고기온이 같아도 최저기온이 낮으면 더 깎인다", () => {
    // TCI 열쾌적은 tempC(낮 최고), 한파는 tminC(아침 최저)를 본다 — 이중 계상이 아니다
    const mild = run({ tempC: 2, tminC: -3 });
    const cold = run({ tempC: 2, tminC: -15 });
    expect(factor(mild, "heat").points).toBe(factor(cold, "heat").points);
    expect(cold.score).toBeLessThan(mild.score);
  });

  it("한파 감점·상한은 환경유형 heat 가중을 따른다 (실내 할인)", () => {
    const outdoor = factor(run({ tminC: -15 }), "cold");
    const indoor = factor(run({ tminC: -15 }, "indoor"), "cold");
    expect(indoor.points).toBeLessThan(outdoor.points);
    // 상한도 함께 줄어야 게이지 비율이 뜻을 갖는다 (thermalMax와 같은 규약)
    expect(indoor.maxPoints).toBeLessThan(outdoor.maxPoints);
  });

  it("산사태: 발령 없으면 요인 없음, 공식 경보(2)는 요인 발생", () => {
    expect(run({ rainMm: 0 }, "outdoor_mountain").factors.some((f) => f.key === "landslide")).toBe(false);
    expect(run({ landslideLevel: 2 }, "outdoor_mountain").factors.some((f) => f.key === "landslide")).toBe(true);
  });

  it("실내는 산사태 발령을 한 단계 완화 — 주의보는 요인 없음, 경보는 주의보 밴드(45)", () => {
    const watchIndoor = run({ landslideLevel: 1 }, "indoor");
    expect(watchIndoor.factors.some((f) => f.key === "landslide")).toBe(false);

    const warnIndoor = run({ landslideLevel: 2 }, "indoor").factors.find(
      (f) => f.key === "landslide",
    )!;
    const warnOutdoor = run({ landslideLevel: 2 }, "outdoor_mountain").factors.find(
      (f) => f.key === "landslide",
    )!;
    expect(warnIndoor.points).toBe(LANDSLIDE.POINTS_BY_LEVEL[1]);
    expect(warnOutdoor.points).toBe(LANDSLIDE.POINTS_BY_LEVEL[2]);
    // 표시 단계는 실제 발령 단계(경보) — 감점만 완화한다
    expect(warnIndoor.value).toBe(2);
    expect(warnIndoor.description).toContain("실내 시설 한 단계 완화");
    expect(warnOutdoor.description).not.toContain("완화");
  });

  it("호우(침수·급류)는 안전층 별도 요인 — rainMm<30 없음, 호우급은 발생하고 disasterRisk에 포함", () => {
    expect(run({ rainMm: 10 }).factors.some((f) => f.key === "heavy_rain")).toBe(false);
    const heavy = run({ rainMm: 95, rainProbPct: 90 });
    const hr = heavy.factors.find((f) => f.key === "heavy_rain");
    expect(hr).toBeDefined();
    expect(hr!.points).toBeGreaterThan(0);
    // 쾌적(weather) 아닌 안전(disaster) 층으로 집계되는지
    expect(heavy.disasterRisk).toBeGreaterThanOrEqual(hr!.points);
    expect(factor(heavy, "rain").points).toBeLessThanOrEqual(30); // 쾌적 강수 상한
  });

  it("응급의료 30km↑는 상한 10, with_seniors는 default보다 크다", () => {
    expect(factor(run({ emergencyRoomKm: 35 }), "medical").points).toBe(10);
    const base = factor(run({ emergencyRoomKm: 20 }), "medical").points;
    const seniors = factor(run({ emergencyRoomKm: 20 }, "outdoor_general", "with_seniors"), "medical").points;
    expect(seniors).toBeGreaterThan(base);
  });

  it("오지 응급의료(먼 병원)는 맑은 날에도 점수를 끌어내린다(취약성 상시)", () => {
    const near = run({ emergencyRoomKm: 5 }).score;
    const far = run({ emergencyRoomKm: 35 }).score;
    expect(far).toBeLessThan(near);
  });
});

describe("재난 경보급 — 감점 앵커로 총점 보장(별도 override 아님)", () => {
  it("산불 4단계(심각)는 다른 조건 무관하게 총점 ≤ ALERT_BAND_CAP", () => {
    const b = run({ tempC: 21, forestFireLevel: 4 }, "outdoor_mountain");
    expect(b.score).toBeLessThanOrEqual(ALERT_BAND_CAP);
    expect(b.grade).toBe("high");
  });

  it("산사태 경보(2)는 총점 ≤ ALERT_BAND_CAP", () => {
    const b = run({ landslideLevel: 2 }, "outdoor_mountain");
    expect(b.score).toBeLessThanOrEqual(ALERT_BAND_CAP);
  });

  it("공식 발령이 없으면 폭우여도 산사태 요인은 없다 — 자체 추정 안 함", () => {
    const b = run({ rainMm: 90, rainProbPct: 90 }, "outdoor_mountain");
    expect(b.factors.some((f) => f.key === "landslide")).toBe(false);
  });

  it("주의보급(산불 3·산사태 1)은 밴드 밖 — 감점만", () => {
    const b = run({ forestFireLevel: 3 });
    expect(b.score).toBeGreaterThan(ALERT_BAND_CAP);
  });
});

describe("점수 일관성 / 등급", () => {
  // 재난 경보급 밴드에 안 드는 케이스들 (산불<4, 산사태<2)
  const cases: Array<[Partial<RiskInput>, PlaceEnvType, Profile]> = [
    [{}, "indoor", "default"],
    [{ tempC: 33, pm25: 50 }, "outdoor_general", "with_kids"],
    [{ rainMm: 20, rainProbPct: 85, windMs: 12 }, "outdoor_water", "default"],
    [{ forestFireLevel: 3, windMs: 10 }, "outdoor_mountain", "with_seniors"],
    [{ tempC: -2, tminC: -14 }, "outdoor_general", "default"], // 한파 활성
    [{ tempC: -2, tminC: -14 }, "indoor", "with_kids"], // 한파 + 실내 할인
  ];

  it("score = 100 − 요인 감점 합, 소계 합 일치 (항상)", () => {
    for (const [input, env, profile] of cases) {
      const b = run(input, env, profile);
      const total = b.factors.reduce((s, f) => s + f.points, 0);
      expect(b.score).toBe(Math.max(0, Math.min(100, 100 - total)));
      expect(b.weatherRisk + b.disasterRisk + b.medicalRisk).toBe(total);
      expect(b.score).toBeGreaterThanOrEqual(0);
      expect(b.score).toBeLessThanOrEqual(100);
    }
  });

  it("카테고리 소계 = 해당 요인 points 합", () => {
    const b = run(
      // tminC로 한파 축까지 켜서 기상 소계가 새 요인을 빠뜨리지 않는지 함께 잠근다
      { tempC: 2, tminC: -14, rainMm: 10, rainProbPct: 70, pm25: 50, forestFireLevel: 3 },
      "outdoor_mountain",
    );
    expect(b.factors.some((f) => f.key === "cold")).toBe(true);
    const sum = (keys: RiskFactorKey[]) =>
      b.factors.filter((f) => keys.includes(f.key)).reduce((s, f) => s + f.points, 0);
    expect(b.weatherRisk).toBe(sum(["heat", "cold", "rain", "wind", "pm", "sun"]));
    expect(b.disasterRisk).toBe(sum(["heavy_rain", "forest_fire", "landslide"]));
    expect(b.medicalRisk).toBe(sum(["medical"]));
  });

  it("gradeForScore 경계: 70→low, 69→moderate, 40→moderate, 39→high", () => {
    expect(gradeForScore(70)).toBe("low");
    expect(gradeForScore(69)).toBe("moderate");
    expect(gradeForScore(40)).toBe("moderate");
    expect(gradeForScore(39)).toBe("high");
  });

  it("profile이 결과에 그대로 담긴다", () => {
    expect(run({}, "indoor", "with_kids").profile).toBe("with_kids");
    expect(run({}).profile).toBe("default");
  });
});

// 중기예보(D+4~) 입력 — 풍속·강수량·체감온도를 제공하지 않는다.
describe("풍속 미제공 — 요인 비표시 + 총점 무결성", () => {
  it("바람 요인이 생성되지 않는다 (일조 축과 동일 규칙)", () => {
    const keys = run({ windMs: undefined }).factors.map((f) => f.key);
    expect(keys).not.toContain("wind");
    expect(keys).toContain("rain"); // 나머지 기상 축은 그대로
  });

  it("요인 설명에 undefined가 새지 않는다", () => {
    for (const f of run({ windMs: undefined }).factors) {
      expect(f.description).not.toContain("undefined");
      expect(Number.isFinite(f.value)).toBe(true);
    }
  });

  it("weatherRisk는 여전히 표시 요인 합과 일치", () => {
    const b = run({ windMs: undefined, tempC: 33, rainProbPct: 70, pm25: 50 });
    const sum = b.factors
      .filter((f) => ["heat", "rain", "wind", "pm", "sun"].includes(f.key))
      .reduce((s, f) => s + f.points, 0);
    expect(b.weatherRisk).toBe(sum);
  });

  it("풍속 결측이 강풍으로 취급되지 않는다 (미풍보다 낮고 강풍보다 높은 점수)", () => {
    expect(run({ windMs: undefined }).score).toBeGreaterThan(run({ windMs: 15 }).score);
    expect(run({ windMs: undefined }).score).toBeLessThanOrEqual(run({ windMs: 0.5 }).score);
  });

  it("중기예보 조합(풍속·강수량·체감온도 없음)도 정상 점수", () => {
    const b = run({
      windMs: undefined,
      rainMm: undefined,
      apparentTempC: undefined,
      sunHours: 8,
    });
    expect(b.score).toBeGreaterThanOrEqual(0);
    expect(b.score).toBeLessThanOrEqual(100);
    expect(b.factors.map((f) => f.key)).not.toContain("heavy_rain"); // 강수량 없음 → 축 비활성
  });
});

/**
 * 민감층 프로필이 실제로 점수를 가르는가.
 * NOTE_민감층_임계값.md가 채택한 "임계값 2℃ 하향"이 코드에서 살아 있는지 지킨다 —
 * 이 근거는 발표에서 인용하는 3대 실증 중 하나다.
 */
describe("민감층 프로필 차등", () => {
  const at = (feels: number, profile: Profile) =>
    computeSafetyScore(
      { ...CLEAR, tempC: feels, apparentTempC: feels },
      { envType: "outdoor_general" },
      profile,
    ).score;

  it("폭염 구간에서 민감층 점수가 더 낮다 (임계값 하향이 살아 있다)", () => {
    for (const feels of [33, 35]) {
      expect(at(feels, "with_kids"), `체감 ${feels}℃`).toBeLessThan(at(feels, "default"));
      expect(at(feels, "with_seniors"), `체감 ${feels}℃`).toBeLessThan(at(feels, "default"));
    }
  });

  it("추운 날·쾌적한 날에는 민감층이 더 높은 점수를 받지 않는다 (역전 금지)", () => {
    // 임계값 하향을 곡선 전체에 걸면 추운 쪽에서 감점이 줄어 "아이 동반이 더 안전"해진다.
    for (const feels of [-8, -1, 0, 5, 16, 22, 24]) {
      expect(at(feels, "with_kids"), `체감 ${feels}℃`).toBeLessThanOrEqual(
        at(feels, "default"),
      );
    }
  });

  it("체감 37℃ 이상은 열쾌적이 바닥이라 차등이 더 벌어지지 않는다 (알려진 한계)", () => {
    // thermalScore의 최저 밴드가 37℃에서 시작한다. 밴드를 늘리는 것은 ASHRAE 근사의
    // 범위를 벗어나므로, 근거 없이 확장하는 대신 한계로 고정해 둔다.
    for (const feels of [37, 39]) {
      expect(at(feels, "with_kids")).toBe(at(feels, "default"));
    }
  });
});

/** 요인 게이지가 배점을 넘지 않는다 — 넘으면 화면에서 막대가 100%를 초과한다 */
describe("요인 표시 상한", () => {
  it("어떤 입력 조합에서도 points ≤ maxPoints", () => {
    const inputs: RiskInput[] = [
      CLEAR,
      { ...CLEAR, tempC: 41, apparentTempC: 41, pm25: 200, rainProbPct: 100 },
      // 중기예보 — 풍속·일조·강수량 결측 → TCI가 축을 빼고 재정규화한다
      {
        ...CLEAR,
        tempC: 38,
        apparentTempC: 38,
        pm25: 90,
        windMs: undefined,
        sunHours: undefined,
        rainMm: undefined,
      },
      { ...CLEAR, rainMm: 95, rainProbPct: 95, landslideLevel: 2 },
    ];
    const envs: PlaceEnvType[] = [
      "indoor",
      "outdoor_water",
      "outdoor_mountain",
      "outdoor_coast",
      "outdoor_general",
    ];
    const profiles: Profile[] = ["default", "with_kids", "with_seniors", "with_kids_seniors"];
    for (const input of inputs)
      for (const envType of envs)
        for (const profile of profiles)
          for (const f of computeSafetyScore(input, { envType }, profile).factors)
            expect(f.points, `${f.key} @ ${envType}/${profile}`).toBeLessThanOrEqual(
              f.maxPoints,
            );
  });
});

/**
 * 민감도 분석(scripts/safety-sensitivity.ts)이 쓰는 교란 주입 구멍.
 * 프로덕션은 이 인자를 전달하지 않으므로, 미전달 시 동작이 완전히 같아야 한다.
 */
describe("SafetyTuning 주입", () => {
  const CASES: RiskInput[] = [
    CLEAR,
    { ...CLEAR, tempC: 36, apparentTempC: 38, forestFireLevel: 3 },
    { ...CLEAR, rainMm: 95, rainProbPct: 95, landslideLevel: 2 },
    { ...CLEAR, emergencyRoomKm: 35, forestFireLevel: 4 },
  ];
  const ENVS: PlaceEnvType[] = [
    "indoor",
    "outdoor_water",
    "outdoor_mountain",
    "outdoor_coast",
    "outdoor_general",
  ];

  it("tuning 미전달과 빈 객체 전달의 결과가 같다", () => {
    for (const input of CASES) {
      for (const envType of ENVS) {
        expect(computeSafetyScore(input, { envType }, "default", {})).toEqual(
          computeSafetyScore(input, { envType }, "default"),
        );
      }
    }
  });

  it("기본 상수를 명시적으로 전달해도 결과가 같다 — 주입 경로가 값을 왜곡하지 않는다", () => {
    const identity = {
      fire: FOREST_FIRE.POINTS_BY_LEVEL,
      landslide: LANDSLIDE.POINTS_BY_LEVEL,
      heavyRain: HEAVY_RAIN.POINTS,
      medicalMult: 1,
      env: { outdoor_mountain: ENV_WEIGHT.outdoor_mountain },
    };
    for (const input of CASES) {
      for (const envType of ENVS) {
        expect(computeSafetyScore(input, { envType }, "default", identity)).toEqual(
          computeSafetyScore(input, { envType }, "default"),
        );
      }
    }
  });

  it("밴드를 키우면 감점이 커지고 표시 상한도 함께 오른다", () => {
    const input = { ...CLEAR, forestFireLevel: 3 as const };
    const base = computeSafetyScore(input, { envType: "outdoor_general" }, "default");
    const up = computeSafetyScore(input, { envType: "outdoor_general" }, "default", {
      fire: { 1: 0, 2: 18, 3: 54, 4: 96 },
    });
    const baseFire = base.factors.find((f) => f.key === "forest_fire")!;
    const upFire = up.factors.find((f) => f.key === "forest_fire")!;
    expect(upFire.points).toBeGreaterThan(baseFire.points);
    // 상한이 고정이면 교란이 clamp에 흡수되어 측정이 무의미해진다
    expect(upFire.maxPoints).toBeGreaterThan(baseFire.maxPoints);
    expect(upFire.points).toBeLessThanOrEqual(upFire.maxPoints);
  });
});
