import { describe, expect, it } from "vitest";
import {
  pickLandslideLevel,
  toActiveAlerts,
  type LandslideAlertRow,
} from "@/lib/risk/landslide";

/** 2026-08-17 12:00 KST */
const NOW = Date.parse("2026-08-17T12:00:00+09:00");
const DAY = 24 * 60 * 60 * 1000;

type Item = Parameters<typeof toActiveAlerts>[0][number];

/** 실응답 필드 형태(스모크 2026-08-17 확인) */
function item(over: Partial<Item> = {}): Item {
  return {
    frcstIssuKindCd: 1,
    frcstIssuStts: "발령",
    frstFrcstIssuDt: "2026-08-17 08:00:00",
    ocrnFrcstIssuInsttNm: "강원특별자치도 인제군",
    ...over,
  };
}

describe("toActiveAlerts — 활성 발령 판정", () => {
  it("해제 기록 없는 발령은 활성이다", () => {
    expect(toActiveAlerts([item()], NOW)).toEqual([
      {
        institution: "강원특별자치도 인제군",
        level: 1,
        issuedAt: "2026-08-17 08:00:00",
      },
    ]);
  });

  it("경보(코드 2)는 단계 2로 읽는다", () => {
    const [row] = toActiveAlerts([item({ frcstIssuKindCd: 2 })], NOW);
    expect(row.level).toBe(2);
  });

  it("연장도 활성이다", () => {
    expect(toActiveAlerts([item({ frcstIssuStts: "연장" })], NOW)).toHaveLength(1);
  });

  it("해제 시각이 지난 행은 제외한다 — 상태가 '발령'으로 남아 있어도", () => {
    const rows = toActiveAlerts(
      [item({ lastFrcstRmvDt: "2026-08-17 10:30:00" })],
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it("해제 상태 행은 제외한다", () => {
    expect(toActiveAlerts([item({ frcstIssuStts: "해제" })], NOW)).toEqual([]);
  });

  it("강원 외 시도는 제외한다 — 동명 시군(경남 고성군) 오염 방지", () => {
    const rows = toActiveAlerts(
      [item({ ocrnFrcstIssuInsttNm: "경상남도 고성군" })],
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it("해제 기록 없이 7일을 넘긴 발령은 원본 누락으로 보고 제외한다", () => {
    const stale = item({ frstFrcstIssuDt: "2026-08-08 08:00:00" }); // 9일 전
    expect(toActiveAlerts([stale], NOW)).toEqual([]);
    expect(toActiveAlerts([stale], NOW - 3 * DAY)).toHaveLength(1);
  });

  it("발령 일시가 없거나 형식이 깨진 행은 제외한다", () => {
    expect(toActiveAlerts([item({ frstFrcstIssuDt: null })], NOW)).toEqual([]);
    expect(toActiveAlerts([item({ frstFrcstIssuDt: "알수없음" })], NOW)).toEqual([]);
  });
});

describe("pickLandslideLevel — 시군 매칭", () => {
  const rows: LandslideAlertRow[] = [
    { institution: "강원특별자치도 인제군", level: 1, issuedAt: "2026-08-17 08:00:00" },
    { institution: "강원특별자치도 인제군", level: 2, issuedAt: "2026-08-17 09:00:00" },
    { institution: "강원도 강릉시", level: 1, issuedAt: "2026-08-17 07:00:00" },
  ];

  it("시군 명칭으로 매칭한다 — 구 표기(강원도)도 포함", () => {
    expect(pickLandslideLevel(rows, 1)).toBe(1); // 강릉시
  });

  it("같은 시군에 여러 건이면 높은 단계를 쓴다", () => {
    expect(pickLandslideLevel(rows, 10)).toBe(2); // 인제군
  });

  it("발령이 없는 시군은 0이다", () => {
    expect(pickLandslideLevel(rows, 13)).toBe(0); // 춘천시
    expect(pickLandslideLevel([], 10)).toBe(0);
  });

  it("모르는 시군 코드는 0이다", () => {
    expect(pickLandslideLevel(rows, 99)).toBe(0);
  });
});
