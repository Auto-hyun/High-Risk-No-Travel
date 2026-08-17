/**
 * 기상청 단기예보(VilageFcstInfoService_2.0/getVilageFcst) 클라이언트.
 *
 * 계약: fetchKmaDailyWeather(nx, ny) — 오늘(KST) 기준 최고기온·최대 강수확률·
 * 최대 풍속·강수량 합계를 반환. 격자당 1시간 캐시(시군 대표점 18곳 = 시간당 최대 18회).
 * 서버 전용 — KMA_API_KEY는 클라이언트 번들에 노출 금지.
 */
import { z } from "zod";
import { apparentTempSummerC } from "./apparent-temp";
import { createTtlCache } from "./cache";

const BASE_URL =
  "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";

/**
 * 당일 조회에 쓰는 발표 시각(KST). 각 발표는 API 반영까지 ~10분 소요.
 * 23시 발표는 다음날 예보부터 시작하므로 당일 조회에는 쓰지 않는다
 * ("오늘의 점수"에 내일 예보가 섞이는 문제) — 자정~02:10 구간 전용.
 */
const BASE_HOURS = [2, 5, 8, 11, 14, 17, 20];
/** 발표 후 API 반영 대기 여유 (분) */
const PUBLISH_DELAY_MIN = 10;

/**
 * 관광 활동시간대(KST, 경계 포함) — 쾌적층(TCI) 입력을 집계하는 창.
 *
 * 강수확률·풍속은 "여행자가 밖에 있는 동안 겪는 불편"이라 새벽 소나기 확률이나
 * 밤바람이 낮 나들이의 쾌적도를 깎으면 안 된다. 일조(SKY)는 해 있는 시간이 기준이라
 * 별도 창(09~18시)을 쓴다.
 *
 * 창을 적용하지 않는 축:
 * - 강수량(PCP) 누적 — 안전층(호우 침수·급류). 호우특보 기준이 일 누적이고, 밤 비는
 *   지반 약화·하천 증수로 다음 낮까지 위험이 남는다.
 * - 기온(TMX/TMN) — 애초에 일 단위 통계값이라 시간대 창이 정의되지 않는다.
 *   체감온도도 이 값들과 기준을 맞춰 하루 전체를 유지한다(여름 최고는 낮이라 실질 동일).
 *
 * 남는 결과: 밤에 실제 강수량이 있는 날은 rainScore의 강수량 축(하루 누적)이 여전히
 * 쾌적을 깎는다 — 젖은 노면·불어난 계곡은 다음 낮의 관광 조건이라 의도된 동작이다.
 */
const ACTIVITY_START = "0900";
const ACTIVITY_END = "2000";

export interface KmaDailyWeather {
  /** 오늘 최고기온 ℃ (TMX, 없으면 남은 시간대 TMP 최댓값) */
  tempC?: number;
  /**
   * 일 최저기온 ℃ (TMN, 없으면 남은 시간대 TMP 최솟값) — 한파 축(weights.ts COLD) 입력.
   *
   * TMN은 하루 한 번(아침) 제공돼, 오늘을 오후에 조회하면 이미 지나 응답에 없다.
   * 그때는 남은 시간대 TMP의 최솟값으로 대체한다 — "지금부터 오늘 안에 겪을 최저"라
   * 방문 판단에는 오히려 이쪽이 맞다. D+1~3은 TMN이 있어 그대로 쓴다.
   */
  tminC?: number;
  /** 오늘 강수확률 최댓값 % (POP) */
  rainProbPct?: number;
  /** 오늘 풍속 최댓값 m/s (WSD) */
  windMs?: number;
  /** 오늘 시간당 강수량(PCP) 합계 mm — 전부 "강수없음"이면 undefined */
  rainMm?: number;
  /** 시간별 TMP×REH 쌍으로 계산한 일 최대 체감온도 ℃ (기상청 여름철 산식) */
  apparentTempC?: number;
  /** 일조시간 대용(h) — 낮시간대 하늘상태(SKY) 평균을 환산. TCI 일조 축 입력. */
  sunHours?: number;
}

/** KST 날짜(YYYYMMDD)와 자정 기준 경과 분 — 서버 타임존에 의존하지 않는다 */
function kstParts(d: Date): { date: string; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * 가장 최근의 "발표시각 + 10분"이 지난 base_date/base_time 선택 (Asia/Seoul 기준).
 * 자정~02:10 사이에는 전날 23시 발표를 쓴다 (23시 발표는 오늘 0시부터의 예보라 라벨과 일치).
 * 23:10~23:59에는 20시 발표를 유지한다 — 23시 발표를 쓰면 "오늘" 요약이 내일 예보가 된다.
 */
export function pickBaseDateTime(now: Date): { baseDate: string; baseTime: string } {
  const { date, minutes } = kstParts(now);
  let picked: number | undefined;
  for (const h of BASE_HOURS) {
    if (minutes >= h * 60 + PUBLISH_DELAY_MIN) picked = h;
  }
  if (picked !== undefined) {
    return { baseDate: date, baseTime: `${String(picked).padStart(2, "0")}00` };
  }
  // 자정~02:10 — 전날 23시 발표 (KST는 DST가 없어 -24h가 정확히 전날이다)
  const prev = kstParts(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  return { baseDate: prev.date, baseTime: "2300" };
}

/**
 * PCP(1시간 강수량) 문자열 파싱.
 * "강수없음"→undefined, "1mm 미만"→0.5, "30.0~50.0mm"→40(중간값), "50.0mm 이상"→50, "1.0mm"→1
 */
export function parsePcp(value: string | undefined | null): number | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (v === "" || v === "-" || v === "강수없음") return undefined;
  if (v.includes("미만")) return 0.5;
  // "30.0~50.0mm" — 범위는 중간값을 취한다. 상한을 쓰면 하루 합산 시
  // 시간대마다 +10mm씩 과대 누적돼 감점이 체계적으로 부풀려진다
  const range = /([\d.]+)\s*~\s*([\d.]+)/.exec(v);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const num = /([\d.]+)/.exec(v);
  if (!num) return undefined;
  const parsed = Number(num[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const kmaItemSchema = z.object({
  category: z.string(),
  fcstDate: z.string(),
  fcstTime: z.string(),
  fcstValue: z.string(),
});
type KmaItem = z.infer<typeof kmaItemSchema>;

const kmaResponseSchema = z.object({
  response: z.object({
    header: z.object({
      resultCode: z.string(),
      resultMsg: z.string().optional(),
    }),
    body: z
      .object({
        items: z.object({ item: z.array(kmaItemSchema) }).optional(),
      })
      .optional(),
  }),
});

function requireApiKey(): string {
  const key = process.env.KMA_API_KEY;
  if (!key) {
    throw new Error(
      "KMA_API_KEY가 설정되지 않았습니다. .env.local에 data.go.kr '일반 인증키(Decoding)' 값을 넣어주세요.",
    );
  }
  return key;
}

/**
 * 활동시간대(ACTIVITY_START~END) 최댓값 — 창 안 데이터가 하나도 없으면 하루 전체로 폴백.
 *
 * 저녁에 "오늘"을 조회하면 활동시간이 이미 지나 응답에 남지 않는다. 그때 undefined를
 * 돌려주면 TCI가 축을 빼고 재정규화하는 게 아니라, RiskInput의 필수 필드(rainProbPct)에
 * mock 값이 그대로 남아 실측 기온과 섞인다 — live.ts의 "핵심값이 있으면 날씨는 통째로
 * 실데이터화" 계약 위반. 지나간 시간대라도 실측이 mock보다 낫다.
 */
function activityMax(byTime: Map<string, number>): number | undefined {
  const all = [...byTime.values()];
  const inWindow = [...byTime.entries()]
    .filter(([t]) => t >= ACTIVITY_START && t <= ACTIVITY_END)
    .map(([, v]) => v);
  const source = inWindow.length > 0 ? inWindow : all;
  return source.length > 0 ? Math.max(...source) : undefined;
}

/**
 * 예보 item 목록 → 하루 요약.
 * fallbackToEarliest(오늘 조회 전용): targetDate의 item이 없으면 가장 이른
 * 예보일로 대체한다. 미래 날짜 조회에서는 끄고 빈 요약을 돌려받아
 * "그 날짜 예보 없음 → 계절모드 폴백" 신호로 쓴다.
 */
export function summarizeDaily(
  items: KmaItem[],
  targetDate: string,
  fallbackToEarliest = true,
): KmaDailyWeather {
  let dayItems = items.filter((i) => i.fcstDate === targetDate);
  if (dayItems.length === 0 && items.length > 0 && fallbackToEarliest) {
    const earliest = items.reduce(
      (min, i) => (i.fcstDate < min ? i.fcstDate : min),
      items[0].fcstDate,
    );
    dayItems = items.filter((i) => i.fcstDate === earliest);
  }

  // 미래 날짜 조회 전용 가드: 응답이 하루 중간에서 끊기면(발표시각별 예보기간 한계·
  // 행 수 절단) 오전 예보만으로 "그날 최고기온"이 과소평가된 반쪽 요약이 만들어진다.
  // 일 최고를 판단할 수 있는 TMX 또는 15시 이후 TMP가 없으면 빈 요약을 반환해
  // "예보 없음 → 계절모드 폴백" 신호로 처리한다. (오늘 조회는 저녁이면 남은 시간대만
  // 있는 게 정상이라 가드를 적용하지 않는다)
  if (!fallbackToEarliest) {
    const coversAfternoon = dayItems.some(
      (i) =>
        i.category === "TMX" ||
        (i.category === "TMP" && i.fcstTime >= "1500"),
    );
    if (!coversAfternoon) return {};
  }

  let tmx: number | undefined;
  let tmn: number | undefined;
  let tmpMax: number | undefined;
  let tmpMin: number | undefined;
  let pcpSum: number | undefined;
  // 강수확률·풍속은 쾌적층(TCI) 입력 — 활동시간대만 집계하려 시각별로 모은다 (activityMax)
  const popByTime = new Map<string, number>();
  const wsdByTime = new Map<string, number>();
  // 체감온도용 시간별 TMP·REH 쌍 — TMX(일최고기온) 발생 시각의 REH는 알 수 없어 시간별 TMP 기반 근사다
  const tmpByTime = new Map<string, number>();
  const rehByTime = new Map<string, number>();
  // 하늘상태(SKY: 1맑음·3구름많음·4흐림) — 일조(TCI) 대용, 낮시간대 평균으로 환산
  const skyByTime = new Map<string, number>();

  for (const item of dayItems) {
    const n = Number(item.fcstValue);
    switch (item.category) {
      case "TMX":
        if (Number.isFinite(n)) tmx = n;
        break;
      case "TMN":
        if (Number.isFinite(n)) tmn = n;
        break;
      case "TMP":
        if (Number.isFinite(n)) {
          tmpMax = tmpMax === undefined ? n : Math.max(tmpMax, n);
          tmpMin = tmpMin === undefined ? n : Math.min(tmpMin, n);
          tmpByTime.set(item.fcstTime, n);
        }
        break;
      case "REH":
        if (Number.isFinite(n)) rehByTime.set(item.fcstTime, n);
        break;
      case "POP":
        if (Number.isFinite(n)) popByTime.set(item.fcstTime, n);
        break;
      case "WSD":
        if (Number.isFinite(n)) wsdByTime.set(item.fcstTime, n);
        break;
      case "SKY":
        if (Number.isFinite(n)) skyByTime.set(item.fcstTime, n);
        break;
      case "PCP": {
        // 하루 누적 강수량(합계) — 호우 특보 임계값이 누적 기준이라 최댓값보다 합계가 적합
        const mm = parsePcp(item.fcstValue);
        if (mm !== undefined) pcpSum = (pcpSum ?? 0) + mm;
        break;
      }
    }
  }

  // 일 최대 체감온도 — TMP·REH가 모두 있는 시각만 계산, 쌍이 하나도 없으면 undefined.
  // 기상청 여름철 산식의 공식 적용 기간(5~9월) 밖에서는 계산하지 않는다 —
  // 겨울에 적용하면 풍속냉각과 반대로 기온보다 높은 "체감"이 표기되는 오류
  const effMonth = Number(dayItems[0]?.fcstDate.slice(4, 6));
  let apparentMax: number | undefined;
  if (effMonth >= 5 && effMonth <= 9) {
    for (const [time, tmp] of tmpByTime) {
      const reh = rehByTime.get(time);
      if (reh === undefined) continue;
      const at = apparentTempSummerC(tmp, reh);
      apparentMax = apparentMax === undefined ? at : Math.max(apparentMax, at);
    }
  }

  // 일조(TCI) 대용 — 낮시간대(09~18시) SKY 평균을 일조시간으로 환산.
  // 맑음(1)→11h, 구름많음(3)→~4.3h, 흐림(4)→1h (선형). SKY 없으면 undefined → TCI가 4축 재정규화.
  const daySky = [...skyByTime.entries()]
    .filter(([t]) => t >= "0900" && t <= "1800")
    .map(([, v]) => v);
  let sunHours: number | undefined;
  if (daySky.length > 0) {
    const meanSky = daySky.reduce((a, b) => a + b, 0) / daySky.length;
    sunHours = meanSky <= 1 ? 11 : meanSky >= 4 ? 1 : 11 - ((meanSky - 1) / 3) * 10;
  }

  const weather: KmaDailyWeather = {};
  const tempC = tmx ?? tmpMax;
  if (tempC !== undefined) weather.tempC = tempC;
  const tminC = tmn ?? tmpMin;
  if (tminC !== undefined) weather.tminC = tminC;
  const popMax = activityMax(popByTime);
  if (popMax !== undefined) weather.rainProbPct = popMax;
  const wsdMax = activityMax(wsdByTime);
  if (wsdMax !== undefined) weather.windMs = wsdMax;
  if (pcpSum !== undefined) weather.rainMm = Math.round(pcpSum * 10) / 10;
  if (apparentMax !== undefined) weather.apparentTempC = apparentMax;
  if (sunHours !== undefined) weather.sunHours = Math.round(sunHours);
  return weather;
}

/**
 * 원시 호출 — 캐시 없이 1회 fetch + 파싱. 스모크 스크립트에서도 사용.
 * targetDate(YYYYMMDD)를 주면 그 날짜(D+1~3)의 예보 요약 — 응답에 해당
 * 날짜가 없으면 빈 요약을 반환한다 (미래 조회는 earliest 폴백 없음).
 */
export async function fetchKmaDailyWeatherRaw(
  nx: number,
  ny: number,
  now: Date = new Date(),
  targetDate?: string,
): Promise<KmaDailyWeather> {
  const items = await fetchKmaGridItemsRaw(nx, ny, now);
  return summarizeDaily(
    items,
    targetDate ?? kstParts(now).date,
    targetDate === undefined,
  );
}

/**
 * 격자 1회 fetch + 파싱 → 예보 item 원본.
 * 응답에는 발표별 전체 기간(오늘~D+3)이 모두 들어 있으므로 HTTP 호출은
 * 격자당 1회면 충분하다 — 날짜별 요약(summarizeDaily)은 로컬 계산.
 */
async function fetchKmaGridItemsRaw(
  nx: number,
  ny: number,
  now: Date,
): Promise<KmaItem[]> {
  const key = requireApiKey();
  const { baseDate, baseTime } = pickBaseDateTime(now);
  const params = new URLSearchParams({
    serviceKey: key,
    dataType: "JSON",
    base_date: baseDate,
    base_time: baseTime,
    nx: String(nx),
    ny: String(ny),
    // 응답 전체(발표별 최대 3일치+α)를 한 페이지로 — 실측 totalCount 944(02시 발표).
    // 500이면 뒤쪽 날짜(D+2~3)가 잘려 "반쪽 예보"가 되거나 D+3 조회가 항상 실패한다
    numOfRows: "1300",
    pageNo: "1",
  });

  // 타임아웃 — 공공데이터포털 무응답 시 페이지 렌더가 무한정 끌려가지 않도록.
  // 초과 시 reject → 호출부의 mock 폴백·failTtl 재시도 경로를 그대로 탄다.
  // next.revalidate: Next Data Cache(1시간) — 모듈 메모리 캐시는 라우트별 번들에
  // 격리돼 /api/warm 크론이 홈 번들 캐시를 못 데운다. Data Cache는 라우트·인스턴스
  // 공유(Vercel은 원격 캐시)라 크론 워밍이 실제 사용자 요청에 닿는다.
  // 캐시 키=URL 전체 — base_date/base_time이 포함돼 발표 주기마다 자연 롤오버.
  const res = await fetch(`${BASE_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(5000),
    next: { revalidate: 60 * 60 },
  });
  const text = await res.text();

  // 키 오류 등은 dataType=JSON을 무시하고 XML(OpenAPI_ServiceResponse)로 온다
  if (text.trimStart().startsWith("<")) {
    const authMsg = /<returnAuthMsg>([^<]*)<\/returnAuthMsg>/.exec(text)?.[1];
    const reasonCode = /<returnReasonCode>([^<]*)<\/returnReasonCode>/.exec(text)?.[1];
    throw new Error(
      `기상청 API가 XML 오류를 반환했습니다: ${authMsg ?? "원인 불명"} (returnReasonCode=${reasonCode ?? "?"})`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `기상청 API 호출 실패: HTTP ${res.status} ${text.trim().slice(0, 100)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`기상청 API 응답이 JSON이 아닙니다: ${text.trim().slice(0, 100)}`);
  }

  const parsed = kmaResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `기상청 API 응답이 예상 스키마와 다릅니다: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const { resultCode, resultMsg } = parsed.data.response.header;
  // 주의: 기상청 정상 코드는 "00" (TourAPI의 "0000"과 다름)
  if (resultCode !== "00") {
    throw new Error(
      `기상청 API 오류 응답: resultCode=${resultCode}, resultMsg=${resultMsg ?? "메시지 없음"}`,
    );
  }

  return parsed.data.response.body?.items?.item ?? [];
}

/**
 * 격자별 예보 item 1시간 캐시 (실패는 5분 후 재시도).
 * 날짜가 아니라 격자 단위로 캐시한다 — 기간(D+1~3) 조회가 같은 응답을
 * 날짜 수만큼 중복 다운로드하던 문제 제거 (105격자 × 4날짜 → 105회).
 */
const cache = createTtlCache<KmaItem[]>(60 * 60 * 1000, 5 * 60 * 1000);

/**
 * 동시 호출 상한 — data.go.kr은 순간 동시 요청이 몰리면 HTTP 429를 돌려준다.
 * 홈 안전지도는 콜드 캐시에서 149격자(산악형 자기 좌표 포함)를 한꺼번에 요청해
 * 90건이 429로 떨어졌고, 실패분이 mock으로 폴백되면서 새로고침마다 시군 점수가
 * 20점대로 요동쳤다. 실측(2026-07-26): 동시 20건까지 429 없음 → 여유를 둬 12.
 */
export const KMA_MAX_CONCURRENT = 12;

let inFlight = 0;
const waiting: (() => void)[] = [];

/** 세마포어 — 상한을 넘는 호출은 앞선 호출이 끝날 때까지 대기시킨다 */
async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= KMA_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
}

/** 격자(nx, ny)의 날씨 요약 — targetDate(YYYYMMDD) 미지정 시 오늘. 1시간 메모리 캐시 */
export async function fetchKmaDailyWeather(
  nx: number,
  ny: number,
  targetDate?: string,
): Promise<KmaDailyWeather> {
  const items = await cache.get(`${nx},${ny}`, () =>
    withConcurrencyLimit(() => fetchKmaGridItemsRaw(nx, ny, new Date())),
  );
  return summarizeDaily(
    items,
    targetDate ?? kstParts(new Date()).date,
    targetDate === undefined,
  );
}
