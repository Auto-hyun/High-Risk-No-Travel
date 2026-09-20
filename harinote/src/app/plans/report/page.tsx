/**
 * 계획 리포트 — 여행 계획 전체를 한 장으로.
 * 일차별로 각 스톱을 그 날짜 기준(실황/예보/계절 통계)으로 재채점해
 * 주의 요인·준비물·응급 대비·대체 플랜을 인쇄·공유 가능한 문서로 제공한다.
 * 계획은 URL 쿼리(?s=contentId.day,…)로 직렬화되어 서버에서 렌더된다.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { diagnosePlan } from "@/lib/plan/diagnose-action";
import { STOP_MODE_LABEL, type StopDiagnosisDto } from "@/lib/plan/diagnose";
import { parseReportQuery, REPORT_MAX_STOPS } from "@/lib/plan/report-params";
import { getPlace } from "@/lib/datasource";
import { lodgingById, type LodgingPlace } from "@/lib/tour/lodging";
import type { Place } from "@/lib/tour/types";
import { buildPlanChecklist } from "@/lib/report/checklist";
import { buildPlanCautions } from "@/lib/report/cautions";
import { nearestHospital } from "@/lib/risk/medical";
import { hasLiveRiskKeys } from "@/lib/risk/live";
import { hasForestKey } from "@/lib/risk/forest";
import { PROFILE_LABEL } from "@/lib/safety/types";
import {
  PLAN_SLOTS,
  SLOT_META,
  totalDistanceKm,
  type PlanSlot,
} from "@/lib/travel-plan";
import {
  addDaysISO,
  dayOffsetSeoul,
  formatKoreanDate,
  todayISOSeoul,
} from "@/lib/date";
import { parseProfile, type SearchParamValue } from "@/components/search-params";
import CourseRouteMap from "@/components/CourseRouteMap";
import ReportActions from "@/components/ReportActions";
import { GRADE_STYLE } from "@/components/SafetyScoreBadge";
import { roadKm } from "@/lib/reco/distance";

interface Props {
  searchParams: Promise<Record<string, SearchParamValue>>;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const sp = await searchParams;
  const q = parseReportQuery(sp.s, sp.from, sp.name);
  return { title: q?.name ? `${q.name} 계획 리포트` : "여행 계획 리포트" };
}

interface ReportRow {
  stop: StopDiagnosisDto;
  place: Place | LodgingPlace;
  slot?: PlanSlot;
  /** 숙박 데이터셋 출신 — 스톱 라벨에 "숙박(참고)" 표기 */
  isLodging: boolean;
}

export default async function PlanReportPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = parseReportQuery(sp.s, sp.from, sp.name);
  if (!q) notFound();

  const profile = parseProfile(sp.profile);
  const transport = sp.tr === "car" ? ("car" as const) : ("transit" as const);

  const [diagnosis, places] = await Promise.all([
    diagnosePlan({ items: q.stops, from: q.from, profile, transport }),
    Promise.all(q.stops.map((st) => getPlace(st.contentId))),
  ]);

  // 데이터에 없는 contentId(깨진 공유 링크 등)는 제외 — 전부 없으면 404.
  // 관광지에 없으면 숙박 데이터셋 폴백 (계획에 담긴 숙소)
  const rows: ReportRow[] = [];
  q.stops.forEach((st, i) => {
    const tourPlace = places[i];
    const place = tourPlace ?? lodgingById(st.contentId);
    const stop = diagnosis.stops[i];
    if (place && stop) {
      rows.push({ stop, place, slot: st.slot, isLodging: tourPlace === null });
    }
  });
  if (rows.length === 0) notFound();
  // 데이터에 없는 contentId는 위에서 조용히 빠진다 — 몇 곳이 사라졌는지 밝히지 않으면
  // 받은 사람은 이 리포트를 계획 전부로 읽는다 (상한 초과 안내와 같은 이유)
  const droppedCount = q.stops.length - rows.length;

  const days = Math.max(...rows.map((r) => r.stop.day));
  // 일차 안에서는 시간 슬롯 순으로 (레거시 URL의 슬롯 없는 스톱은 원래 순서 유지)
  const slotIdx = (r: ReportRow) => PLAN_SLOTS.indexOf(r.slot ?? "morning");
  const byDay: ReportRow[][] = Array.from({ length: days }, (_, i) =>
    rows.filter((r) => r.stop.day === i + 1).sort((a, b) => slotIdx(a) - slotIdx(b)),
  );

  const scored = rows.filter((r) => r.stop.score !== null);
  const worst =
    scored.length > 0
      ? scored.reduce((w, r) => ((r.stop.score ?? 100) < (w.stop.score ?? 100) ? r : w))
      : null;
  const riskyRows = rows.filter(
    (r) => r.stop.grade !== null && r.stop.grade !== "low",
  );

  // 동선은 하루 안에서만 이어지므로 일차별 거리를 합한다 (마지막 스톱 → 다음 날 첫 스톱은 이동이 아니다)
  const planItems = (dayRows: ReportRow[]) =>
    dayRows.map(({ place }) => ({
      contentId: place.contentId,
      title: place.title,
      lat: place.lat,
      lng: place.lng,
    }));
  const tripDistanceKm =
    Math.round(
      byDay.reduce((sum, dayRows) => sum + totalDistanceKm(planItems(dayRows)), 0) * 10,
    ) / 10;

  const checklist = buildPlanChecklist(
    rows.map((r) => ({
      riskFactors: r.stop.riskFactors,
      envType: r.place.envType,
    })),
    profile,
  );
  const cautions = buildPlanCautions(
    rows.map((r) => ({
      dateISO: r.stop.dateISO,
      title: r.place.title,
      envType: r.place.envType,
      riskFactors: r.stop.riskFactors,
    })),
    profile,
  );

  // 올해가 아니면 연도를 붙인다 — 리포트는 URL로 오래 돌아다니는데, "1월 1일"만
  // 적어 두면 지난 계획인지 내년 계획인지 받은 사람이 알 방법이 없다
  const today = todayISOSeoul();
  const dateText = (dateISO: string) =>
    dateISO.slice(0, 4) === today.slice(0, 4)
      ? formatKoreanDate(dateISO)
      : `${dateISO.slice(0, 4)}년 ${formatKoreanDate(dateISO)}`;

  // diagnosePlan은 "지난 날짜"와 "1년 넘게 남은 날짜"를 똑같이 오늘 출발로 되돌린다.
  // 한 문구로 뭉뚱그리면 내년 여행 계획에 "출발일이 지났다"는 거짓말이 나간다
  const staleFrom =
    diagnosis.assumedToday && q.from
      ? dayOffsetSeoul(q.from) < 0
        ? ("past" as const)
        : ("far" as const)
      : null;

  // 실연동 키가 없으면 기상·미세먼지·산불위험은 시범값이다 — 쓰지도 않은 기관을
  // 출처로 적으면 종이만 받아 본 사람에게는 확인할 방법이 없는 거짓말이 된다
  const liveKeys = hasLiveRiskKeys();
  const forestKey = liveKeys && hasForestKey();
  const dataSources = [
    "한국관광공사 TourAPI",
    ...(liveKeys ? ["기상청", "AirKorea"] : []),
    ...(forestKey ? ["산림청"] : []),
    "국립중앙의료원",
    "행정안전부",
  ].join(" · ");
  const trialNote = !liveKeys
    ? " 기상·미세먼지·산불위험은 시범값 기준입니다."
    : !forestKey
      ? " 산불위험은 시범값 기준입니다."
      : "";

  // 제목 옆 여행 기간. 출발일이 없으면 날짜를 지어낼 수 없으므로 무엇을 기준으로
  // 채점했는지라도 밝힌다 (diagnosePlan이 오늘 출발로 가정해 계산한다)
  const tripRange = q.from
    ? days === 1
      ? dateText(q.from)
      : `${dateText(q.from)} → ${dateText(addDaysISO(q.from, days - 1))}`
    : "출발일 미설정 · 오늘 기준";

  return (
    // 종이 폭이 정확히 A4(210mm)가 되도록 좌우 여백(px-4)만큼 상한을 넓혀 잡는다
    <div className="mx-auto w-full max-w-[calc(210mm_+_2rem)] px-4 py-8 print:max-w-none print:px-0 print:py-0">
      {/* 인쇄 시 사이트 헤더·푸터 숨김 + A4 맞춤 — 이 라우트에만 적용.
          화면 종이는 미디어쿼리로 직접 쓴다 — sm:와 print: 유틸리티를 겹치면
          인쇄 폭(A4≈794px)이 sm 분기점을 넘어 화면용 여백이 인쇄물에 따라붙는다 */}
      <style>{`
        @media print {
          /* 여백을 0으로 두어야 브라우저가 날짜·문서제목 머리글/바닥글을 찍지 않는다.
             종이 여백은 .a4-sheet 안쪽 padding으로 준다 */
          @page { size: A4; margin: 0; }
          body > header, body > footer { display: none !important; }
          body { background: #fff !important; }
          /* 문서 여백 — 한글·워드 기본값대로 20mm대. @page 여백은 0이어야 브라우저
             머리글/꼬리글이 안 찍히므로 여백은 여기서 준다 */
          .a4-sheet { padding: 20mm; }
          section { break-inside: avoid; }
          /* 일차 섹션은 반 페이지를 넘길 수 있어 통째로 미루면 빈 공간만 남는다 —
             안에서 끊되 제목만 페이지 끝에 남거나 스톱 하나가 갈라지는 것은 막는다 */
          .day-section { break-inside: auto; }
          h2 { break-after: avoid; }
          li { break-inside: avoid; }
        }
        @media screen and (min-width: 640px) {
          .a4-sheet { min-height: 297mm; padding: 20mm; }
        }
      `}</style>

      <Link
        href="/plans"
        className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 transition-colors hover:text-teal-700 print:hidden"
      >
        <span aria-hidden="true">←</span> 저장한 계획으로 돌아가기
      </Link>

      {/* A4 한 장(.a4-sheet) — 안쪽 여백이 @page 여백과 같아 화면 줄바꿈이 인쇄물과 일치한다.
          좁은 화면에서는 폭만 줄인다 (A4 비율로 강제 축소하면 글씨가 읽을 수 없게 작아진다) */}
      <article className="a4-sheet mt-4 bg-white px-5 py-6 shadow-lg ring-1 ring-slate-200 print:mt-0 print:shadow-none print:ring-0">
        {/* ① 헤더 */}
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4 print:pb-3">
          <div className="min-w-0">
            <p className="text-xs font-bold tracking-wide text-teal-700">
              하리노트 · High Risk, No Travel
            </p>
            <h1 className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-2xl font-extrabold tracking-tight text-slate-900 print:text-xl">
              {q.name ?? "내 여행 계획"}
              <span className="text-base font-bold text-slate-400 print:text-sm">
                {tripRange}
              </span>
            </h1>
          </div>
          <ReportActions />
        </header>

        {/* 출발일이 지난 계획 — diagnosePlan이 조용히 오늘 기준으로 다시 계산한다(assumedToday).
            이 사실을 밝히지 않으면 "1일차 · 8월 1일"이라는 제목 아래 오늘 날씨로 매긴 점수가
            놓여, 리포트 전체가 지난 날짜의 예보인 것처럼 읽힌다. */}
        {/* 상한 초과로 뒤쪽 스톱이 빠졌다 — 조용히 사라지면 리포트를 완전한 것으로 읽는다 */}
        {/* 세 배너는 예외 안내일 뿐이라 채운 카드로 두면 결론(② 요약)보다 먼저 눈에 든다.
            왼쪽 선만 남긴 주석 스타일로 낮춘다 */}
        {q.truncated && (
          <p className="mt-3 border-l-2 border-amber-400 pl-3 text-xs leading-relaxed text-slate-600">
            스톱이 {REPORT_MAX_STOPS}곳을 넘어 <strong>앞 {REPORT_MAX_STOPS}곳만</strong>{" "}
            담았어요. 나머지는 이 리포트에 없습니다.
          </p>
        )}

        {droppedCount > 0 && (
          <p className="mt-3 border-l-2 border-amber-400 pl-3 text-xs leading-relaxed text-slate-600">
            데이터에서 찾지 못한 <strong>{droppedCount}곳</strong>은 이 리포트에서
            빠졌어요. 링크가 오래됐거나 관광지 정보가 바뀐 경우입니다.
          </p>
        )}

        {staleFrom && q.from && (
          <p className="mt-3 border-l-2 border-amber-400 pl-3 text-xs leading-relaxed text-slate-600">
            출발일({dateText(q.from)})이{" "}
            {staleFrom === "past" ? "지나" : "1년 넘게 남아"}, 아래 점수는{" "}
            <strong>오늘({formatKoreanDate(today)}) 기준</strong>으로 계산했어요.
            일차별 날짜는 원래 계획 날짜입니다.
          </p>
        )}

        {/* ② 계획 요약 — 지표 넉 줄로 규모를 먼저 보이고, 결론은 한 줄로.
            이 결론 배너가 종이에서 유일한 색 블록이라 눈이 먼저 닿는다 */}
        <section className="mt-5 print:mt-4">
          {/* 가장 주의할 곳은 아래 결론 배너가 말한다 — 여기서 되풀이하지 않는다 */}
          <dl className="grid grid-cols-3 gap-x-4">
            {[
              { k: "일정", v: `${days}일 · ${rows.length}곳` },
              { k: "총 이동(직선)", v: `${tripDistanceKm}km` },
              { k: "주의 스톱", v: `${riskyRows.length}곳 / ${rows.length}곳` },
            ].map(({ k, v }) => (
              <div key={k} className="border-l-2 border-slate-200 pl-2.5">
                <dt className="text-[11px] font-semibold text-slate-400">{k}</dt>
                <dd className="truncate text-sm font-bold tabular-nums text-slate-800">
                  {v}
                </dd>
              </div>
            ))}
          </dl>

          {riskyRows.length === 0 ? (
            <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">
              전 스톱 방문 주의 요인 낮음 — 일정 그대로 진행해도 좋아요
            </p>
          ) : (
            // 스톱 수는 바로 위 지표가 말했으므로 되풀이하지 않고 어디를 볼지만 짚는다
            <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">
              {worst && worst.stop.score !== null ? (
                <>
                  가장 주의가 필요한 곳: <strong>{worst.place.title}</strong>{" "}
                  <span className="tabular-nums">({worst.stop.score}점)</span>
                </>
              ) : (
                <>일차별 점검에서 ⚠ 표시된 스톱을 확인하세요</>
              )}
            </p>
          )}
        </section>

        {/* ③ 준비물·주의할 점 — 출발 전에 읽을 것이라 일차별 점검보다 앞에 둔다 */}
        <section className="mt-6 grid gap-x-6 gap-y-5 sm:grid-cols-2 print:mt-4 print:grid-cols-2">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              준비물 체크리스트
              <span className="ml-1.5 text-xs font-semibold text-slate-400">
                {PROFILE_LABEL[profile]} 기준
              </span>
            </h2>
            <ul className="mt-2 space-y-1.5">
              {checklist.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-slate-700">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 inline-block h-4 w-4 shrink-0 rounded border border-slate-300"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          {cautions.length > 0 && (
            <div>
              <h2 className="text-base font-bold text-slate-900">주의할 점</h2>
              <ul className="mt-2 space-y-2">
                {cautions.map(({ key, text }) => (
                  <li
                    key={key}
                    className="flex items-start gap-2 text-sm leading-relaxed text-slate-700"
                  >
                    <span aria-hidden="true" className="shrink-0 text-amber-500">
                      ⚠
                    </span>
                    {text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* ④ 일차별 점검 — 시간 슬롯을 왼쪽 축으로 세워 하루 흐름이 보이게 한다 */}
        {byDay.map((dayRows, i) =>
          dayRows.length === 0 ? null : (
            // 하루의 시작점을 구분선으로 세운다 — 섹션 제목이 모두 같은 크기라
            // 구분이 없으면 이틀 이상 계획에서 어디부터 다음 날인지 스캔되지 않는다
            <section
              key={i}
              className="day-section mt-6 border-t border-slate-200 pt-4 print:mt-4 print:pt-3"
            >
              <h2 className="flex flex-wrap items-center gap-x-2 text-base font-bold text-slate-900">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-extrabold text-slate-600">
                  {i + 1}일차
                </span>
                {q.from && <span>{dateText(addDaysISO(q.from, i))}</span>}
                {/* 점수 근거는 날짜가 정하므로 하루에 한 번만 밝힌다 (스톱마다 반복하지 않는다).
                    데이터 없는 스톱이 맨 앞에 오면 그 하나 때문에 하루 전체가
                    "데이터 없음"으로 적히므로, 점수가 나온 스톱을 기준으로 삼는다 */}
                <span className="text-xs font-semibold text-slate-400">
                  {
                    STOP_MODE_LABEL[
                      dayRows.find((r) => r.stop.mode !== "unknown")?.stop.mode ??
                        "unknown"
                    ]
                  }
                </span>
              </h2>
              <ul className="mt-2">
                {dayRows.map(({ stop, place, slot, isLodging }, j) => {
                  const hospital = nearestHospital(place.lat, place.lng, place.contentId);
                  const last = j === dayRows.length - 1;
                  return (
                    <li key={stop.contentId} className="flex gap-3">
                      {/* 시간 축 — 라벨 아래 세로선이 다음 스톱까지 이어진다 */}
                      <div className="flex w-11 shrink-0 flex-col items-center">
                        <span className="text-xs font-bold text-slate-500">
                          {slot ? SLOT_META[slot].label : "일정"}
                        </span>
                        {!last && (
                          <span
                            aria-hidden="true"
                            className="mt-1.5 w-px flex-1 bg-slate-200"
                          />
                        )}
                      </div>
                      <div className={`min-w-0 flex-1 ${last ? "" : "pb-4"}`}>
                        <div className="flex items-start justify-between gap-3">
                          <p className="min-w-0 text-sm font-bold text-slate-800">
                            {/* 숙박도 상세로 연결된다 (places/[contentId] 폴백) */}
                            <Link
                              href={`/places/${place.contentId}`}
                              className="hover:underline"
                            >
                              {place.title}
                            </Link>
                            {isLodging && (
                              <span className="ml-1.5 text-xs font-semibold text-slate-400">
                                숙박(참고)
                              </span>
                            )}
                          </p>
                          {stop.score !== null && stop.grade !== null ? (
                            <span
                              className={`shrink-0 text-sm font-extrabold tabular-nums ${GRADE_STYLE[stop.grade].text}`}
                            >
                              {stop.grade !== "low" && "⚠ "}
                              {stop.score}점
                            </span>
                          ) : (
                            <span className="shrink-0 text-xs font-semibold text-slate-400">
                              점수 데이터 없음
                            </span>
                          )}
                        </div>
                        {place.addr && (
                          <p className="mt-0.5 text-xs text-slate-500">{place.addr}</p>
                        )}
                        {hospital && (
                          <p className="mt-0.5 text-xs text-slate-400">
                            응급의료 {hospital.name}{" "}
                            <span className="tabular-nums">
                              {hospital.km.toFixed(1)}km
                            </span>
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {dayRows.length >= 2 && (
                <>
                  <p className="mt-1.5 text-xs font-semibold text-slate-500">
                    이동 직선{" "}
                    <span className="tabular-nums">
                      {totalDistanceKm(planItems(dayRows))}km
                    </span>{" "}
                    — 실제 소요 시간은 지도 앱에서 확인하세요
                  </p>
                  {/* 하루 동선 지도 — 타일 이미지라 인쇄물에서는 뺀다 */}
                  <div className="mt-2 print:hidden">
                    <CourseRouteMap
                      stops={dayRows.map(({ place }) => ({
                        title: place.title,
                        lat: place.lat,
                        lng: place.lng,
                      }))}
                    />
                  </div>
                </>
              )}
            </section>
          ),
        )}

        {/* ⑤ 대체 플랜 — 주의 스톱의 같은 날짜 기준 교체 후보 */}
        {riskyRows.some((r) => r.stop.alternatives.length > 0) && (
          <section className="mt-6 print:mt-4">
            <h2 className="text-base font-bold text-slate-900">대체 플랜</h2>
            <ul className="mt-2 space-y-1.5">
              {riskyRows.flatMap(({ stop, place }) =>
                stop.alternatives.length === 0
                  ? []
                  : [
                      <li key={stop.contentId} className="text-sm text-slate-700">
                        <strong className="font-bold text-slate-900">
                          {place.title}
                        </strong>
                        <span className="text-slate-400"> 대신 → </span>
                        {stop.alternatives.map((alt, j) => (
                          <span key={alt.contentId}>
                            {j > 0 && <span className="text-slate-300"> · </span>}
                            <Link
                              href={`/places/${alt.contentId}`}
                              className="font-bold text-teal-700 hover:underline print:text-slate-900"
                            >
                              {alt.title}
                            </Link>{" "}
                            <span className="tabular-nums">
                              ({alt.score}점 · 약 {roadKm(alt.distanceKm)}km)
                            </span>
                          </span>
                        ))}
                      </li>,
                    ],
              )}
            </ul>
          </section>
        )}

        {/* 참고 정보 고지·출처 — 종이만 받아 본 사람에게는 이 줄이 유일한 근거 표시다
            (화면에는 사이트 푸터에도 있지만 인쇄에서는 그쪽이 숨겨진다) */}
        <p className="mt-4 text-[11px] leading-relaxed text-slate-400 print:mt-3">
          공공데이터 기반 참고 정보입니다 — 안전을 보장하지 않습니다.{trialNote} 출처:{" "}
          {dataSources}
        </p>
      </article>
    </div>
  );
}
