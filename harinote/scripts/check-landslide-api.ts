/**
 * 산림청 산사태 예보발령 키 스모크 테스트 — 실행: npx tsx scripts/check-landslide-api.ts
 * 전국 최신 발령 100건을 1회 실호출해 강원 활성 발령과 시군별 단계를 확인한다.
 * 키는 FOREST_API_KEY, 없으면 data.go.kr 공용 키(TOUR_API_KEY)를 재사용한다.
 * 외부 의존성 없음 (Node 내장 process.loadEnvFile 사용, dotenv 금지).
 * 주의: 서비스 키 값은 절대 출력하지 않는다.
 */
import {
  fetchActiveLandslideAlertsRaw,
  pickLandslideLevel,
} from "../src/lib/risk/landslide";
import { SIGUNGU_ADM_CODES } from "../src/lib/risk/forest";
import { LANDSLIDE } from "../src/lib/safety/weights";

try {
  process.loadEnvFile(".env.local");
} catch {
  console.log("[i] .env.local이 없습니다 — 셸 환경변수만 사용합니다.");
}

const DATASET = "산림청_산사태 예보발령 정보";
const APPLY_URL = "https://www.data.go.kr/data/15074798/openapi.do";

async function main(): Promise<void> {
  console.log("[1] 산사태 예보발령 호출 중... (전국 최신 발령 100건 조회 후 강원 필터)");
  if (!process.env.FOREST_API_KEY && !process.env.TOUR_API_KEY) {
    console.error(
      "    [x] FOREST_API_KEY(또는 TOUR_API_KEY)가 없습니다. .env.local을 확인하세요.",
    );
    process.exitCode = 1;
    return;
  }

  let rows;
  try {
    rows = await fetchActiveLandslideAlertsRaw();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    [x] ${msg}`);
    if (/forbidden/i.test(msg)) {
      console.error(
        `    → 키는 인식되지만 '${DATASET}' 활용신청이 없거나 반영 대기 중입니다.\n` +
          `      ${APPLY_URL} 에서 신청 후 1~2시간 뒤 재시도하세요.`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(`    [ok] 강원 활성 발령 ${rows.length}건`);
  for (const row of rows) {
    console.log(
      `      · ${row.institution} — ${LANDSLIDE.LEVEL_LABEL[row.level]} (발령 ${row.issuedAt})`,
    );
  }
  if (rows.length === 0) {
    console.log("      (현재 강원에 발령된 산사태 주의보·경보 없음 — 정상 응답)");
  }

  console.log("\n[2] 시군별 단계 매핑");
  for (const [code, region] of Object.entries(SIGUNGU_ADM_CODES)) {
    const level = pickLandslideLevel(rows, Number(code));
    if (level > 0) {
      console.log(
        `    ${region.name}: ${level}단계(${LANDSLIDE.LEVEL_LABEL[level]}) — 감점 ${LANDSLIDE.POINTS_BY_LEVEL[level]}점`,
      );
    }
  }
  console.log("    (표시 없는 시군은 발령 없음 → 산사태 감점 0)");
}

main().catch((err) => {
  console.error("[x] 스모크 테스트 실패:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
