import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLiveRiskInput } from "@/lib/risk/live";
import { fetchLandslideLevel } from "@/lib/risk/landslide";

vi.mock("@/lib/risk/landslide", () => ({
  fetchLandslideLevel: vi.fn(),
}));

const fetchLandslideLevelMock = vi.mocked(fetchLandslideLevel);

const place = {
  contentId: 126508,
  envType: "outdoor_mountain" as const,
  sigunguCode: 10, // 인제
  lat: 38.0695,
  lng: 128.1707,
};

describe("getLiveRiskInput — 산사태 예보발령 반영", () => {
  beforeEach(() => {
    fetchLandslideLevelMock.mockReset();
    vi.stubEnv("KMA_API_KEY", "test-kma-key");
    vi.stubEnv("AIRKOREA_API_KEY", "test-airkorea-key");
    // 기상·미세먼지는 실패시켜 산사태 경로만 본다 (실패해도 throw하지 않는 계약)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("발령 중이면 단계가 input.landslideLevel로 들어간다", async () => {
    fetchLandslideLevelMock.mockResolvedValue(2);
    const input = await getLiveRiskInput(place);
    expect(input.landslideLevel).toBe(2);
  });

  it("발령이 없으면 0이 들어간다 — 감점 없음", async () => {
    fetchLandslideLevelMock.mockResolvedValue(0);
    const input = await getLiveRiskInput(place);
    expect(input.landslideLevel).toBe(0);
  });

  it("조회가 실패하면 throw 없이 미설정으로 두고 경고를 남긴다", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchLandslideLevelMock.mockRejectedValue(new Error("Forbidden"));
    const input = await getLiveRiskInput(place);
    expect(input.landslideLevel).toBeUndefined();
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("산사태")),
    ).toBe(true);
  });

  it("실연동 키가 없으면 산사태 API를 호출하지 않는다 — 키 없으면 네트워크 0", async () => {
    vi.stubEnv("AIRKOREA_API_KEY", "");
    fetchLandslideLevelMock.mockResolvedValue(1);
    const input = await getLiveRiskInput(place);
    expect(fetchLandslideLevelMock).not.toHaveBeenCalled();
    expect(input.landslideLevel).toBeUndefined();
  });
});
