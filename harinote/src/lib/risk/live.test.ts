import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apparentTempSummerC } from "@/lib/risk/apparent-temp";
import { getLiveRiskInput, gridPointFor, hasLiveRiskKeys } from "@/lib/risk/live";
import { nearestHospitalKm } from "@/lib/risk/medical";
import { mockRiskInputFor } from "@/fixtures/safety/risk-inputs";
import { latLngToGrid } from "@/lib/risk/kma-grid";
import { SIGUNGU_SEATS } from "@/lib/risk/regions";

/** 오늘(KST) YYYYMMDD — 예보 item의 fcstDate용 */
function kstToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll("-", "");
}

const place = {
  contentId: 126508,
  envType: "outdoor_general" as const,
  sigunguCode: 13, // 춘천
  lat: 37.8813,
  lng: 127.7298,
};

describe("hasLiveRiskKeys", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("두 키가 모두 있으면 true", () => {
    vi.stubEnv("KMA_API_KEY", "test-kma-key");
    vi.stubEnv("AIRKOREA_API_KEY", "test-airkorea-key");
    expect(hasLiveRiskKeys()).toBe(true);
  });

  it("하나라도 없으면 false", () => {
    vi.stubEnv("KMA_API_KEY", "test-kma-key");
    vi.stubEnv("AIRKOREA_API_KEY", "");
    expect(hasLiveRiskKeys()).toBe(false);
  });
});

describe("gridPointFor — 격자 선택", () => {
  // 발왕산 자락 좌표 (평창군청에서 ~30km, 표고 1,400m대) — 시군청 격자와 달라야 한다
  const mountainPlace = {
    envType: "outdoor_mountain" as const,
    sigunguCode: 15, // 평창
    lat: 37.6358,
    lng: 128.3957,
  };

  it("일반 야외는 시군 대표점 격자를 쓴다", () => {
    const seat = SIGUNGU_SEATS[13]; // 춘천
    expect(gridPointFor(place)).toEqual(latLngToGrid(seat.lat, seat.lng));
  });

  it("산악형은 시군 대표점 대신 자기 좌표 격자를 쓴다", () => {
    const own = latLngToGrid(mountainPlace.lat, mountainPlace.lng);
    expect(gridPointFor(mountainPlace)).toEqual(own);

    const seat = SIGUNGU_SEATS[15];
    expect(own).not.toEqual(latLngToGrid(seat.lat, seat.lng));
  });

  it("시군코드가 없으면 자기 좌표 격자로 폴백한다", () => {
    const noSigungu = { ...place, sigunguCode: undefined };
    expect(gridPointFor(noSigungu)).toEqual(latLngToGrid(place.lat, place.lng));
  });
});

describe("getLiveRiskInput — 전체 실패 폴백", () => {
  beforeEach(() => {
    vi.stubEnv("KMA_API_KEY", "test-kma-key");
    vi.stubEnv("AIRKOREA_API_KEY", "test-airkorea-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("두 소스가 모두 실패하면 throw 없이 mock을 반환하고, 경고는 1회만 남긴다", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 응급의료 거리만은 네트워크 없이 내장 좌표로 실계산된다
    const expected = (p: typeof place) => ({
      ...mockRiskInputFor(p),
      emergencyRoomKm: Math.round(nearestHospitalKm(p.lat, p.lng) * 10) / 10,
    });

    const first = await getLiveRiskInput(place);
    expect(first).toEqual(expected(place));

    // 두 번째 호출(다른 관광지, 같은 시군)에도 경고가 중복되지 않는다
    const second = await getLiveRiskInput({ ...place, contentId: 226001 });
    expect(second).toEqual(expected({ ...place, contentId: 226001 }));

    // 경고는 종류별 1회씩만 — 기상·미세먼지 전체 실패 1 + 산사태 조회 실패 1.
    // 두 번째 호출(같은 시군의 다른 관광지)에서는 어느 쪽도 다시 찍히지 않는다.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes("산사태"))).toHaveLength(1);
  });
});

describe("getLiveRiskInput — 체감온도(apparentTempC) 반영", () => {
  beforeEach(() => {
    vi.stubEnv("KMA_API_KEY", "test-kma-key");
    vi.stubEnv("AIRKOREA_API_KEY", "test-airkorea-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** 오늘 KST 날짜(YYYYMMDD) — summarizeDaily의 targetDate와 맞춘다 */
  function kstToday(): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" })
      .format(new Date())
      .replaceAll("-", "");
  }

  /** 기상청 호출만 성공(JSON), 나머지 소스(AirKorea·산불)는 실패하도록 fetch 스텁 */
  function stubFetchKmaOnly(items: Array<Record<string, string>>) {
    const body = JSON.stringify({
      response: {
        header: { resultCode: "00" },
        body: { items: { item: items } },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown) =>
        String(url).includes("VilageFcstInfoService")
          ? Promise.resolve({ ok: true, text: () => Promise.resolve(body) })
          : Promise.reject(new Error("other source down")),
      ),
    );
  }

  const kmaItem = (category: string, fcstValue: string, fcstTime = "1500") => ({
    category,
    fcstDate: kstToday(),
    fcstTime,
    fcstValue,
  });

  it("날씨 응답에 TMP·REH 쌍이 있으면 input.apparentTempC에 반영된다", async () => {
    stubFetchKmaOnly([
      kmaItem("TMP", "31"),
      kmaItem("REH", "80"),
      kmaItem("POP", "10"),
      kmaItem("WSD", "3"),
    ]);
    // 강릉(sigunguCode 1) — 다른 테스트와 격자가 달라 kma 모듈 캐시가 섞이지 않는다
    const input = await getLiveRiskInput({ ...place, sigunguCode: 1 });
    expect(input.tempC).toBe(31);
    expect(input.apparentTempC).toBe(apparentTempSummerC(31, 80));
  });

  it("날씨 응답에 REH가 없으면 input에 apparentTempC가 남지 않는다", async () => {
    stubFetchKmaOnly([
      kmaItem("TMP", "31"),
      kmaItem("POP", "10"),
      kmaItem("WSD", "3"),
    ]);
    // 동해(sigunguCode 3) — 위 테스트와 격자 분리
    const input = await getLiveRiskInput({ ...place, sigunguCode: 3 });
    expect(input.tempC).toBe(31);
    expect(input.apparentTempC).toBeUndefined();
    expect("apparentTempC" in input).toBe(false);
  });

  it("날씨 응답의 TMN이 input.tminC로 들어간다 — 한파 축 입력", async () => {
    // 겨울 예보: 낮 최고 -2℃인데 아침 최저는 -11℃. 두 값이 각각
    // 쾌적층(TCI 열쾌적)과 안전층(한파)의 입력이 된다
    stubFetchKmaOnly([
      kmaItem("TMN", "-11", "0600"),
      kmaItem("TMP", "-2"),
      kmaItem("POP", "0"),
      kmaItem("WSD", "2"),
    ]);
    // 삼척(sigunguCode 5) — 위 테스트들과 격자 분리
    const input = await getLiveRiskInput({ ...place, sigunguCode: 5 });
    expect(input.tempC).toBe(-2);
    expect(input.tminC).toBe(-11);
  });

  it("기온 항목이 없으면 input에 tminC가 남지 않는다", async () => {
    stubFetchKmaOnly([kmaItem("POP", "40"), kmaItem("WSD", "3")]);
    // 속초(sigunguCode 7) — 격자 분리
    const input = await getLiveRiskInput({ ...place, sigunguCode: 7 });
    expect(input.tminC).toBeUndefined();
    expect("tminC" in input).toBe(false);
  });
});

describe("getLiveRiskInput — 산악 격자 실패 시 시군 대표점 폴백", () => {
  const mountainPlace = {
    contentId: 126508,
    envType: "outdoor_mountain" as const,
    sigunguCode: 15, // 평창
    lat: 37.6358,
    lng: 128.3957,
  };

  beforeEach(() => {
    vi.stubEnv("KMA_API_KEY", "test-kma-key");
    vi.stubEnv("AIRKOREA_API_KEY", "test-airkorea-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("자기 격자가 429로 실패하면 mock이 아니라 시군 대표점 예보를 쓴다", async () => {
    const own = latLngToGrid(mountainPlace.lat, mountainPlace.lng);
    const seat = SIGUNGU_SEATS[15];
    const seatGrid = latLngToGrid(seat.lat, seat.lng);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(String(url));
        const nx = Number(u.searchParams.get("nx"));
        const ny = Number(u.searchParams.get("ny"));
        // AirKorea는 실패시켜 pm25는 논외로 둔다
        if (!u.pathname.includes("VilageFcst")) throw new Error("airkorea down");
        // 산악 자기 격자 → 429
        if (nx === own.nx && ny === own.ny) {
          return new Response("rate limit", { status: 429 });
        }
        // 시군 대표점 격자 → 정상 예보 (기온 19℃로 식별)
        if (nx === seatGrid.nx && ny === seatGrid.ny) {
          return new Response(
            JSON.stringify({
              response: {
                header: { resultCode: "00" },
                body: {
                  items: {
                    item: [
                      { category: "TMP", fcstDate: kstToday(), fcstTime: "1500", fcstValue: "19" },
                      { category: "POP", fcstDate: kstToday(), fcstTime: "1500", fcstValue: "10" },
                      { category: "WSD", fcstDate: kstToday(), fcstTime: "1500", fcstValue: "2" },
                    ],
                  },
                },
              },
            }),
            { status: 200 },
          );
        }
        throw new Error("unexpected grid");
      }),
    );

    const input = await getLiveRiskInput(mountainPlace);
    const mock = mockRiskInputFor(mountainPlace);

    expect(input.tempC).toBe(19); // 대표점 실예보
    expect(input.tempC).not.toBe(mock.tempC); // mock 누출 아님
    expect(input.rainProbPct).toBe(10);
  });
});
