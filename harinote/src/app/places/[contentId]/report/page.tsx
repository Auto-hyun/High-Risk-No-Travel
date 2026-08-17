/**
 * 출발 전 체크 리포트 — 제안서 기능 ⑤.
 * "산악기상·산불·응급의료를 한 장으로 요약 제공" — 출력·공유 전제의 문서형 화면.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlace, getPlacesWithSafety, getRiskInput } from "@/lib/datasource";
import { computeSafetyScore } from "@/lib/safety/score";
import { PROFILE_LABEL } from "@/lib/safety/types";
import { medicalDataSource, nearestHospital } from "@/lib/risk/medical";
import { hasLiveRiskKeys } from "@/lib/risk/live";
import { hasForestKey } from "@/lib/risk/forest";
import { recommendAlternatives } from "@/lib/reco/alternatives";
import { shouldAnchorOnAlternative } from "@/lib/course/half-day";
import { buildChecklist } from "@/lib/report/checklist";
import ReportActions from "@/components/ReportActions";
import SafetyScoreBadge from "@/components/SafetyScoreBadge";
import {
  parseProfile,
  profileParam,
  buildQuery,
  type SearchParamValue,
} from "@/components/search-params";

interface Props {
  params: Promise<{ contentId: string }>;
  searchParams: Promise<Record<string, SearchParamValue>>;
}

function parseContentId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const contentId = parseContentId((await params).contentId);
  if (contentId === null) return { title: "출발 전 체크 리포트" };
  const place = await getPlace(contentId);
  return {
    title: place
      ? `${place.title} 출발 전 체크 리포트`
      : "출발 전 체크 리포트",
  };
}

/** 서버 렌더 시점의 오늘 날짜 — Asia/Seoul 기준 */
function todaySeoul(): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "full",
    timeZone: "Asia/Seoul",
  }).format(new Date());
}

export default async function ReportPage({ params, searchParams }: Props) {
  const [{ contentId: rawId }, sp] = await Promise.all([params, searchParams]);
  const contentId = parseContentId(rawId);
  if (contentId === null) notFound();

  const profile = parseProfile(sp.profile);
  const place = await getPlace(contentId);
  if (!place) notFound();

  const riskInput = await getRiskInput(place);
  const safety = computeSafetyScore(riskInput, place, profile);
  const placeWithSafety = { ...place, safety };

  // 대체 플랜: 상세 페이지와 동일한 추천 로직 재사용.
  // 코스 본체는 상세 페이지 몫 — 리포트는 "코스 변경 권고 여부"만 필요하므로
  // 전량 코스 계산 대신 앵커 판정 함수만 사용한다.
  const candidates = await getPlacesWithSafety(undefined, profile);
  const alternatives = recommendAlternatives(placeWithSafety, candidates);
  const recommendCourseSwitch = shouldAnchorOnAlternative(
    placeWithSafety,
    alternatives,
  );

  const topFactors = safety.factors
    .filter((f) => f.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3);

  const checklist = buildChecklist(riskInput, place, profile);
  const hospital = nearestHospital(place.lat, place.lng, place.contentId);
  const profileQuery = buildQuery({ profile: profileParam(profile) });

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 print:max-w-none print:px-0 print:py-0">
      {/* 인쇄 시 사이트 헤더·푸터 숨김 + A4 한 장 맞춤 — 이 라우트에만 적용 */}
      <style>{`
        @media print {
          /* 여백을 0으로 두어야 브라우저가 날짜·문서제목 머리글/바닥글을 찍지 않는다.
             종이 여백은 .report-sheet 안쪽 padding으로 준다 */
          @page { size: A4; margin: 0; }
          body > header, body > footer { display: none !important; }
          body { background: #fff !important; }
          /* 문서 여백 — 한글·워드 기본값대로 20mm대 (계획 리포트와 동일) */
          .report-sheet { padding: 20mm; }
          section { break-inside: avoid; }
        }
      `}</style>

      <Link
        href={`/places/${place.contentId}${profileQuery}`}
        className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 transition-colors hover:text-teal-700 print:hidden"
      >
        <span aria-hidden="true">←</span> 상세로 돌아가기
      </Link>

      <article className="report-sheet mt-4 rounded-2xl bg-white p-6 ring-1 ring-slate-200 print:mt-0 print:rounded-none print:ring-0">
        {/* ① 헤더 */}
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4 print:pb-3">
          <div>
            <p className="text-xs font-bold tracking-wide text-teal-700">
              하리노트 · 출발 전 체크 리포트
            </p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-slate-900 print:text-xl">
              {place.title}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {todaySeoul()} · {PROFILE_LABEL[profile]} 기준
            </p>
            <p className="mt-0.5 text-xs text-slate-400">{place.addr}</p>
          </div>
          <ReportActions />
        </header>

        {/* ② 점수 요약 */}
        <section className="mt-5 print:mt-4">
          <SafetyScoreBadge score={safety.score} grade={safety.grade} size="lg" />
        </section>

        {/* ③ 오늘의 주의 요인 */}
        <section className="mt-6 print:mt-4">
          <h2 className="text-base font-bold text-slate-900">
            오늘의 주의 요인
          </h2>
          {topFactors.length === 0 ? (
            <p className="mt-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">
              특별한 주의 요인이 없어요
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {topFactors.map((f) => (
                <li
                  key={f.key}
                  className="rounded-xl bg-slate-50 px-4 py-2.5 ring-1 ring-slate-200"
                >
                  <p className="text-sm font-bold text-slate-800">
                    {f.label}{" "}
                    <span className="font-semibold text-slate-500 tabular-nums">
                      {f.value}
                      {f.unit}
                    </span>
                    <span className="float-right font-extrabold text-red-600 tabular-nums">
                      −{f.points}점
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {f.description}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ④ 준비물 체크리스트 */}
        <section className="mt-6 print:mt-4">
          <h2 className="text-base font-bold text-slate-900">
            준비물 체크리스트
          </h2>
          <ul className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2 print:grid-cols-2">
            {checklist.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-sm text-slate-700"
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 inline-block h-4 w-4 shrink-0 rounded border border-slate-300"
                />
                {item}
              </li>
            ))}
          </ul>
        </section>

        {/* ⑤ 응급 대비 */}
        <section className="mt-6 print:mt-4">
          <h2 className="text-base font-bold text-slate-900">응급 대비</h2>
          <div className="mt-2 rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
            {hospital ? (
              <p className="text-sm text-slate-700">
                최근접 응급의료기관:{" "}
                <strong className="font-bold text-slate-900">
                  {hospital.name}
                </strong>{" "}
                <span className="tabular-nums">
                  (직선 약 {hospital.km.toFixed(1)}km)
                </span>
              </p>
            ) : (
              <p className="text-sm text-slate-700">
                주변 응급의료기관 정보를 불러오지 못했어요 — 이동 경로의 병원
                위치를 미리 확인하세요.
              </p>
            )}
            <p className="mt-1 text-sm font-bold text-red-700">
              위급 시 지체 없이 119에 신고하세요.
            </p>
          </div>
        </section>

        {/* ⑥ 대체 플랜 */}
        {alternatives.length > 0 && (
          <section className="mt-6 print:mt-4">
            <h2 className="text-base font-bold text-slate-900">대체 플랜</h2>
            {recommendCourseSwitch && (
              <p className="mt-1 text-sm font-semibold text-amber-700">
                오늘은 코스 변경을 권해요 — 아래 대체지 중심의 반나절 코스를
                추천해요.
              </p>
            )}
            <ul className="mt-2 space-y-1.5">
              {alternatives.slice(0, 2).map((alt) => (
                <li key={alt.contentId} className="text-sm text-slate-700">
                  <Link
                    href={`/places/${alt.contentId}${profileQuery}`}
                    className="font-bold text-teal-700 hover:underline print:text-slate-900"
                  >
                    {alt.title}
                  </Link>{" "}
                  <span className="tabular-nums">
                    — 안전점수 {alt.safety.score}점 · {alt.distanceKm.toFixed(1)}
                    km
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ⑦ 푸터 */}
        <footer className="mt-6 border-t border-slate-200 pt-3 text-xs leading-relaxed text-slate-400 print:mt-4">
          <p>
            본 리포트는 공공데이터 기반 참고 정보이며 안전을 보장하지 않습니다.
            방문 전 기상특보와 현지 안내를 반드시 확인하세요.
          </p>
          <p className="mt-1">
            데이터 출처: 한국관광공사 TourAPI · {medicalDataSource()}
            {hasLiveRiskKeys()
              ? hasForestKey()
                ? " · 기상청 · AirKorea(한국환경공단) · 산림청(산불위험예보·산사태 예보발령)."
                : " · 기상청 · AirKorea(한국환경공단). 산불위험은 실연동 준비 중인 시범값입니다."
              : ". 기상·미세먼지·산불위험은 시범값 기준입니다."}
          </p>
        </footer>
      </article>
    </div>
  );
}
