/**
 * 실데이터 RiskInput 조립 — 기상청 단기예보 + AirKorea PM2.5 + 산림청 산불위험지수·산사태 예보발령.
 *
 * 점진적 실데이터화: mockRiskInputFor를 베이스로
 * tempC·rainProbPct·rainMm·windMs·pm25·forestFireLevel·landslideLevel은 실데이터로 덮어쓰고,
 * emergencyRoomKm는 내장 좌표(hospitals.gangwon.json)로 실계산한다.
 * (산불위험은 활용신청 승인 완료로 실데이터 — 2026-07-28 스모크 확인.
 * 키가 만료·차단돼 Forbidden이 되면 해당 필드만 mock으로 자동 폴백된다.)
 *
 * 안정성 계약: 개별 소스 실패 시 해당 필드만 mock 유지(부분 성공 허용),
 * 전체 실패 시에도 throw하지 않고 mock 전체를 반환한다 (화면이 죽으면 안 됨).
 * 서버 전용 모듈.
 */
import type { Place } from "@/lib/tour/types";
import type { RiskInput } from "@/lib/safety/types";
import { mockRiskInputFor } from "@/fixtures/safety/risk-inputs";
import { latLngToGrid } from "./kma-grid";
import { fetchKmaDailyWeather } from "./kma";
import { fetchMidDailyWeather } from "./kma-mid";
import { getGangwonPm25 } from "./airkorea";
import { fetchForestFireLevel } from "./forest";
import { fetchLandslideLevel } from "./landslide";
import { nearestHospitalKm } from "./medical";
import { SIGUNGU_SEATS } from "./regions";

/** 실연동에 필요한 두 키가 모두 있는가 — 없으면 호출부는 mock 경로를 쓴다 */
export function hasLiveRiskKeys(): boolean {
  return Boolean(process.env.KMA_API_KEY && process.env.AIRKOREA_API_KEY);
}

/** 전체 실패 경고는 프로세스당 1회만 — 2,091곳 순회 시 로그 폭주 방지 */
let warnedAllSourcesFailed = false;
/** 산사태 조회 실패 경고도 프로세스당 1회 */
let warnedLandslideFailed = false;

/**
 * 기상청 격자 선택.
 * 기본은 시군 대표점(시군청 소재지) — 시군당 1회 호출 + 캐시.
 * 단 산악형(outdoor_mountain)은 시군청과 표고 차이가 커서(강원은 최대 1,000m+)
 * 대표점 예보가 실제 기상과 크게 어긋난다 → 자기 좌표 격자를 쓴다.
 * 격자(~5km) 단위로 캐시되므로 인접 산악지끼리는 슬롯을 공유해 호출 폭증은 없다.
 */
export function gridPointFor(
  place: Pick<Place, "envType" | "sigunguCode" | "lat" | "lng">,
): { nx: number; ny: number } {
  const seat =
    place.envType !== "outdoor_mountain" && place.sigunguCode !== undefined
      ? SIGUNGU_SEATS[place.sigunguCode]
      : undefined;
  return latLngToGrid(seat?.lat ?? place.lat, seat?.lng ?? place.lng);
}

export async function getLiveRiskInput(
  place: Pick<Place, "contentId" | "envType" | "sigunguCode" | "lat" | "lng">,
): Promise<RiskInput> {
  const input = mockRiskInputFor(place);

  // 응급의료 거리 — 내장 병원 좌표 기반 실계산 (네트워크·키 불필요).
  // 병원 데이터가 비어 있으면(Infinity) 해당 필드만 mock 유지.
  const erKm = nearestHospitalKm(place.lat, place.lng, place.contentId);
  if (Number.isFinite(erKm)) {
    input.emergencyRoomKm = Math.round(erKm * 10) / 10;
  }

  // 격자 선택: 기본은 시군 대표점, 산악형은 자기 좌표 (gridPointFor 참고)
  const { nx, ny } = gridPointFor(place);

  // 산불·산사태는 같은 게이트를 쓴다 (시군 코드 + 실연동 키)
  const gatedSigungu =
    place.sigunguCode !== undefined && hasLiveRiskKeys() ? place.sigunguCode : undefined;

  const [weather, pm25, forestFire, landslide] = await Promise.allSettled([
    fetchKmaDailyWeather(nx, ny),
    getGangwonPm25(place.sigunguCode),
    // 시군 코드가 없거나 실연동 키가 없으면 산불 조회는 건너뛴다 (rejected → mock 유지).
    // hasLiveRiskKeys 게이트: 키 없는 환경(clean checkout·CI)에서 forest가
    // TOUR_API_KEY 폴백으로 네트워크를 태우지 않도록 — "키 없으면 네트워크 0" 불변식 유지
    gatedSigungu !== undefined
      ? fetchForestFireLevel(gatedSigungu)
      : Promise.reject(
          new Error("실연동 키/시군코드 없음 — 산불위험 조회 생략"),
        ),
    gatedSigungu !== undefined
      ? fetchLandslideLevel(gatedSigungu)
      : Promise.reject(
          new Error("실연동 키/시군코드 없음 — 산사태 예보발령 조회 생략"),
        ),
  ]);

  // 자기 좌표 격자(산악형)가 실패하면 시군 대표점 예보로 폴백한다.
  // mock으로 떨어뜨리면 데모용 극단 시나리오(폭염 36℃·호우 80mm)가 실서비스 점수에
  // 섞여 새로고침마다 등급이 뒤집힌다 — 인접 실측이 언제나 mock보다 낫다.
  let weatherValue = weather.status === "fulfilled" ? weather.value : undefined;
  if (weatherValue === undefined && place.sigunguCode !== undefined) {
    const seat = SIGUNGU_SEATS[place.sigunguCode];
    const seatGrid = seat ? latLngToGrid(seat.lat, seat.lng) : undefined;
    if (seatGrid && (seatGrid.nx !== nx || seatGrid.ny !== ny)) {
      weatherValue = await fetchKmaDailyWeather(seatGrid.nx, seatGrid.ny).catch(
        () => undefined,
      );
    }
  }

  if (weatherValue !== undefined) {
    const w = weatherValue;
    // 핵심값이 하나도 없는 빈 응답(발표 직후 등)은 실데이터로 취급하지 않고 mock 전체 유지
    // — 일부만 덮어쓰면 mock 기온 + 실측 강수 같은 혼종 상태가 된다
    const hasCore =
      w.tempC !== undefined ||
      w.rainProbPct !== undefined ||
      w.windMs !== undefined;
    if (hasCore) {
      if (w.tempC !== undefined) input.tempC = w.tempC;
      // 최저기온(한파 축) — 없으면 삭제해 mock 잔존값이 안 섞이게 (rainMm과 같은 패턴)
      if (w.tminC !== undefined) input.tminC = w.tminC;
      else delete input.tminC;
      if (w.rainProbPct !== undefined) input.rainProbPct = w.rainProbPct;
      if (w.windMs !== undefined) input.windMs = w.windMs;
      // 실예보가 "강수없음"이면 mock의 rainMm도 제거 — 날씨 필드는 통째로 실데이터화
      if (w.rainMm !== undefined) input.rainMm = w.rainMm;
      else delete input.rainMm;
      // 체감온도 — rainMm과 같은 패턴: REH 쌍이 없으면 삭제해 mock 잔존값 혼입 방지
      if (w.apparentTempC !== undefined) input.apparentTempC = w.apparentTempC;
      else delete input.apparentTempC;
      // 일조(하늘상태 환산) — SKY 없으면 삭제해 TCI가 4축 재정규화
      if (w.sunHours !== undefined) input.sunHours = w.sunHours;
      else delete input.sunHours;
    }
  }

  if (pm25.status === "fulfilled") {
    input.pm25 = Math.round(pm25.value);
  }

  if (forestFire.status === "fulfilled") {
    input.forestFireLevel = forestFire.value;
  }

  // 산사태 — 산림청 공식 예보발령만 쓴다(자체 추정 없음).
  // 조회가 실패하면 미설정 = 발령 없음(감점 0)과 구분되지 않는다. 다른 축은 실패해도
  // mock 값이 남지만 산사태만은 위험이 통째로 사라지므로 경고를 남긴다(프로세스당 1회).
  if (landslide.status === "fulfilled") {
    input.landslideLevel = landslide.value;
  } else if (gatedSigungu !== undefined && !warnedLandslideFailed) {
    warnedLandslideFailed = true;
    const reason = landslide.reason;
    console.warn(
      "[risk/live] 산사태 예보발령 조회가 실패해 산사태 축이 '발령 없음'으로 계산됩니다.",
      reason instanceof Error ? reason.message : reason,
    );
  }

  if (weatherValue === undefined && pm25.status === "rejected") {
    if (!warnedAllSourcesFailed) {
      warnedAllSourcesFailed = true;
      const reason = weather.status === "rejected" ? weather.reason : undefined;
      console.warn(
        "[risk/live] 기상청·AirKorea 조회가 모두 실패해 mock 위험 입력으로 대체합니다.",
        reason instanceof Error ? reason.message : reason,
      );
    }
  }

  return input;
}

/**
 * 중기예보(D+4~10) 기반 입력 조립.
 *
 * 기상만 중기예보로 교체하고 미세먼지·산불·응급의료는 오늘 기준을 유지한다
 * (단기 경로와 같은 원칙 — 미래 예보가 없는 소스는 현재값 각주로 안내).
 * 중기예보는 풍속·강수량·습도를 주지 않으므로 해당 필드를 지운다 —
 * TCI가 없는 축을 제외하고 재정규화하므로 정보 없는 축이 불이익을 주지 않는다.
 * 범위 밖이거나 조회 실패면 null → 호출부는 계절 모드로 폴백한다.
 */
export async function getMidRiskInput(
  place: Pick<Place, "contentId" | "envType" | "sigunguCode" | "lat" | "lng">,
  targetISO: string,
): Promise<RiskInput | null> {
  if (place.sigunguCode === undefined) return null;
  const w = await fetchMidDailyWeather(place.sigunguCode, targetISO).catch(() => null);
  if (!w) return null;

  const input = await getLiveRiskInput(place);
  input.tempC = w.tempC;
  input.tminC = w.tminC;
  if (w.rainProbPct !== undefined) input.rainProbPct = w.rainProbPct;
  if (w.sunHours !== undefined) input.sunHours = w.sunHours;
  else delete input.sunHours;
  // 중기예보 미제공 — 축을 비활성으로 두어 TCI가 재정규화하게 한다
  delete input.windMs;
  delete input.rainMm;
  delete input.apparentTempC;
  return input;
}

/**
 * 미래 날짜(D+1~3) 예보 기반 입력 조립.
 * 기상만 targetDate 예보로 교체하고 pm25·산불·응급의료는 오늘 기준을 유지한다
 * (미래 예보가 없는 소스 — UI에서 "현재 기준" 각주로 안내).
 * 해당 날짜 예보가 응답에 없으면 null — 호출부는 계절모드로 폴백한다.
 */
export async function getForecastRiskInput(
  place: Pick<Place, "contentId" | "envType" | "sigunguCode" | "lat" | "lng">,
  targetKmaDate: string,
): Promise<RiskInput | null> {
  const { nx, ny } = gridPointFor(place);
  const w = await fetchKmaDailyWeather(nx, ny, targetKmaDate).catch(() => undefined);
  const hasCore =
    w !== undefined &&
    (w.tempC !== undefined || w.rainProbPct !== undefined || w.windMs !== undefined);
  if (!hasCore) return null;

  const input = await getLiveRiskInput(place);
  if (w.tempC !== undefined) input.tempC = w.tempC;
  // 오늘 기준으로 채워진 최저기온을 대상 날짜 예보로 교체 (없으면 삭제 — 한파 축 비활성)
  if (w.tminC !== undefined) input.tminC = w.tminC;
  else delete input.tminC;
  if (w.rainProbPct !== undefined) input.rainProbPct = w.rainProbPct;
  if (w.windMs !== undefined) input.windMs = w.windMs;
  if (w.rainMm !== undefined) input.rainMm = w.rainMm;
  else delete input.rainMm;
  if (w.apparentTempC !== undefined) input.apparentTempC = w.apparentTempC;
  else delete input.apparentTempC;
  if (w.sunHours !== undefined) input.sunHours = w.sunHours;
  else delete input.sunHours;
  return input;
}
