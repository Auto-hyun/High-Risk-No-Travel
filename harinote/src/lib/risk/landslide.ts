/**
 * 산림청 산사태정보시스템 산사태 예보발령 클라이언트.
 *
 * 데이터셋: "산림청_산사태 예보발령 정보"
 * 활용신청: https://www.data.go.kr/data/15074798/openapi.do
 * 원출처: 산사태정보시스템 https://sansatai.forest.go.kr
 *   (권역 토양함수지수 80% 도달 시 주의보, 100% 시 경보 — weights.ts LANDSLIDE 참고)
 *
 * 계약: fetchLandslideLevel(sigunguCode) — 시군의 현재 발령 단계 0|1|2.
 * 전국 발령 이력을 1회 호출(최신 100건)해 강원 행만 걸러 15분 캐시하고,
 * "해제 시각이 없는 발령/연장" 행만 활성으로 본다. 발령이 없으면 0(정상 응답).
 * 서비스 키 미설정·미승인·네트워크 실패면 throw — 호출부(live.ts)가 경고를 남기고 축을 비운다.
 * 서버 전용 — 서비스 키는 클라이언트 번들에 노출 금지.
 */
import { z } from "zod";
import { createTtlCache } from "./cache";
import { SIGUNGU_ADM_CODES } from "./forest";

const BASE_URL =
  "https://apis.data.go.kr/1400000/forecastIssueService/forecastIssueList";

/**
 * 해제 기록 없이 이 기간을 넘긴 "발령" 행은 활성으로 보지 않는다.
 * 산사태 주의보·경보는 강우 종료 후 수 시간~하루 내 해제되므로, 며칠째 해제
 * 기록이 없는 행은 원본의 해제 누락으로 본다 — 그대로 두면 한 시군이 영구히
 * 45점 감점을 안는다.
 */
const MAX_ACTIVE_DAYS = 7;

/** 활성 발령 1건 — 기관명은 "강원특별자치도 인제군" 형태 */
export interface LandslideAlertRow {
  /** 예보발령 기관명(시도 + 시군구) */
  institution: string;
  /** 1 주의보 / 2 경보 */
  level: 1 | 2;
  /** 발령 일시 (원문 "YYYY-MM-DD HH:mm:ss", KST) */
  issuedAt: string;
}

// item이 1건이면 배열이 아닌 단일 객체로 오는 data.go.kr 관례에 대비
const alertItemSchema = z.object({
  frcstIssuKindCd: z.coerce.number().nullable().optional(),
  frcstIssuStts: z.string().nullable().optional(),
  frstFrcstIssuDt: z.string().nullable().optional(),
  lastFrcstRmvDt: z.string().nullable().optional(),
  ocrnFrcstIssuInsttNm: z.string().nullable().optional(),
});
type AlertItem = z.infer<typeof alertItemSchema>;

const alertResponseSchema = z.object({
  response: z.object({
    header: z.object({
      resultCode: z.string(),
      resultMsg: z.string().optional(),
    }),
    body: z
      .object({
        items: z
          .union([
            z.object({
              item: z.union([z.array(alertItemSchema), alertItemSchema]),
            }),
            // 발령 0건이면 items가 빈 문자열로 오는 게이트웨이 관례
            z.string(),
          ])
          .optional(),
      })
      .optional(),
  }),
});

/** KST 문자열("YYYY-MM-DD HH:mm:ss") → epoch ms. 형식이 다르면 undefined */
function parseKstTime(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const ms = Date.parse(`${text.trim().replace(" ", "T")}+09:00`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * 응답 행 → 활성 발령만 (순수 함수 — 테스트용 분리).
 * 활성 조건: 상태가 발령·연장 + 해제 시각이 없거나 아직 미래 + 발령 후 7일 이내.
 */
export function toActiveAlerts(items: AlertItem[], nowMs: number): LandslideAlertRow[] {
  const rows: LandslideAlertRow[] = [];
  for (const item of items) {
    const institution = item.ocrnFrcstIssuInsttNm ?? "";
    if (!institution.includes("강원")) continue;
    if (item.frcstIssuStts !== "발령" && item.frcstIssuStts !== "연장") continue;

    const removedAt = parseKstTime(item.lastFrcstRmvDt);
    if (removedAt !== undefined && removedAt <= nowMs) continue;

    const issuedAt = parseKstTime(item.frstFrcstIssuDt);
    if (issuedAt === undefined) continue;
    if (nowMs - issuedAt > MAX_ACTIVE_DAYS * 24 * 60 * 60 * 1000) continue;

    const level = item.frcstIssuKindCd === 2 ? 2 : 1;
    rows.push({ institution, level, issuedAt: item.frstFrcstIssuDt ?? "" });
  }
  return rows;
}

/** 원시 호출 — 최신 발령 100건 조회 후 강원 활성 발령만 반환. 스모크 스크립트에서도 사용 */
export async function fetchActiveLandslideAlertsRaw(): Promise<LandslideAlertRow[]> {
  // 같은 data.go.kr 계정 키 — 전용 키가 없으면 공용 키(TOUR_API_KEY)를 재사용
  const key = process.env.FOREST_API_KEY ?? process.env.TOUR_API_KEY;
  if (!key) {
    throw new Error(
      "FOREST_API_KEY(또는 TOUR_API_KEY)가 설정되지 않았습니다. .env.local에 data.go.kr '일반 인증키(Decoding)' 값을 넣어주세요.",
    );
  }

  const params = new URLSearchParams({
    ServiceKey: key,
    pageNo: "1",
    // 발령 행만 최신순 100건 — 실측(2026-08) 기준 2개월치를 덮으므로
    // 활성 발령(길어야 하루)은 전부 이 안에 들어온다
    numOfRows: "100",
    _type: "json",
    frcstIssuStts: "발령",
  });

  // 타임아웃 — forest.ts와 동일한 이유 (무응답 API가 렌더를 붙잡지 않도록)
  const res = await fetch(`${BASE_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();

  if (res.status === 401) {
    throw new Error(
      "산사태 예보발령 API Unauthorized: 키를 인식하지 못합니다. 디코딩 키인지 확인하세요.",
    );
  }
  if (res.status === 403) {
    throw new Error(
      "산사태 예보발령 API Forbidden: 이 키에 '산림청_산사태 예보발령 정보' 활용신청이 없습니다. https://www.data.go.kr/data/15074798/openapi.do 에서 신청하세요.",
    );
  }
  // 구형 게이트웨이 XML 오류(OpenAPI_ServiceResponse)도 방어
  if (text.trimStart().startsWith("<")) {
    const authMsg = /<returnAuthMsg>([^<]*)<\/returnAuthMsg>/.exec(text)?.[1];
    const reasonCode = /<returnReasonCode>([^<]*)<\/returnReasonCode>/.exec(text)?.[1];
    throw new Error(
      `산사태 예보발령 API가 XML 오류를 반환했습니다: ${authMsg ?? "원인 불명"} (returnReasonCode=${reasonCode ?? "?"})`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `산사태 예보발령 API 호출 실패: HTTP ${res.status} ${text.trim().slice(0, 100)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `산사태 예보발령 API 응답이 JSON이 아닙니다: ${text.trim().slice(0, 100)}`,
    );
  }

  const parsed = alertResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `산사태 예보발령 API 응답이 예상 스키마와 다릅니다: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const { resultCode, resultMsg } = parsed.data.response.header;
  if (resultCode !== "00") {
    throw new Error(
      `산사태 예보발령 API 오류 응답: resultCode=${resultCode}, resultMsg=${resultMsg ?? "메시지 없음"}`,
    );
  }

  const items = parsed.data.response.body?.items;
  if (items === undefined || typeof items === "string") return [];
  const list: AlertItem[] = Array.isArray(items.item) ? items.item : [items.item];
  return toActiveAlerts(list, Date.now());
}

/**
 * 15분 캐시 — 원본은 시군이 발령/해제할 때마다 갱신되고 호우 상황에서 몇 시간 단위로
 * 바뀐다. 산불(2시간)보다 짧게 잡아 발령·해제를 빠르게 반영한다 (실패는 5분 후 재시도).
 */
const cache = createTtlCache<LandslideAlertRow[]>(15 * 60 * 1000, 5 * 60 * 1000);

function fetchActiveLandslideAlerts(): Promise<LandslideAlertRow[]> {
  return cache.get("gangwon", fetchActiveLandslideAlertsRaw);
}

/**
 * 활성 발령 목록에서 시군의 단계 선택 (순수 함수 — 테스트용 분리).
 * 강원 행만 들어오므로 동명 시군(경남 고성군 등) 충돌은 없다. 같은 시군에 여러 건이면
 * 높은 단계를 쓴다.
 */
export function pickLandslideLevel(
  rows: LandslideAlertRow[],
  sigunguCode: number,
): 0 | 1 | 2 {
  const region = SIGUNGU_ADM_CODES[sigunguCode];
  if (!region) return 0;
  let level: 0 | 1 | 2 = 0;
  for (const row of rows) {
    if (!row.institution.includes(region.name)) continue;
    if (row.level > level) level = row.level;
  }
  return level;
}

/**
 * 시군의 현재 산사태 예보발령 단계 (0 없음 / 1 주의보 / 2 경보).
 * 조회 실패는 throw — 호출부(live.ts)가 경고를 남기고 산사태 축을 비운다.
 */
export async function fetchLandslideLevel(sigunguCode: number): Promise<0 | 1 | 2> {
  const rows = await fetchActiveLandslideAlerts();
  return pickLandslideLevel(rows, sigunguCode);
}
