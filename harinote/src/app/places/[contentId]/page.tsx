import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getDateSafety,
  getPlaceWithSafety,
  getPlacesWithSafety,
  getPlacesWithSafetyOnDate,
  getPlacesWithSafetyOnRange,
  getRangeSafety,
} from "@/lib/datasource";
import { formatKoreanDate } from "@/lib/date";
import { ENV_TYPE_LABEL, placeTypeLabel } from "@/lib/tour/types";
import { GRADE_LABEL, PROFILE_LABEL } from "@/lib/safety/types";
import { Suspense } from "react";
import { recommendAlternatives } from "@/lib/reco/alternatives";
import { buildHalfDayCourse } from "@/lib/course/half-day";
import CourseTimeline from "@/components/CourseTimeline";
import PlaceCard from "@/components/PlaceCard";
import PlaceGallery from "@/components/PlaceGallery";
import PlaceMap from "@/components/PlaceMap";
import { GallerySection, OverviewSection, PetSection, ReviewsSection } from "./sections";
import LodgingDetail from "./lodging-detail";
import { lodgingById } from "@/lib/tour/lodging";
import { getLodgingWithSafety } from "@/lib/tour/lodging-safety";
import { kidsAmenityLabels, kidsInfoOf } from "@/lib/tour/kids-friendly";
import { summaryOf } from "@/lib/tour/summaries";
import AddToPlanButton from "@/components/AddToPlanButton";
import ProfileChips from "@/components/ProfileChips";
import RiskBreakdownBar from "@/components/RiskBreakdownBar";
import SafetyScoreBadge, { GRADE_STYLE } from "@/components/SafetyScoreBadge";
import RangeDayStrip from "@/components/RangeDayStrip";
import {
  parseDateRange,
  parseProfile,
  parseTransport,
  profileParam,
  buildQuery,
  type SearchParamValue,
} from "@/components/search-params";
import {
  savedDate,
  savedEnd,
  savedProfile,
  savedTransport,
} from "@/lib/prefs";
import { CAR_DISTANCE_KM, MAX_DISTANCE_KM } from "@/lib/reco/alternatives";
import PrefsPersist from "@/components/PrefsPersist";
import { roadKm } from "@/lib/reco/distance";

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
  if (contentId === null) return { title: "관광지 상세" };
  const place = await getPlaceWithSafety(contentId);
  if (place) return { title: `${place.title} 안전 점수` };
  // 숙박은 별도 데이터셋 (lodging.gangwon.json)
  const lodging = lodgingById(contentId);
  return { title: lodging ? `${lodging.title} 안전 점수` : "관광지 상세" };
}

export default async function PlaceDetailPage({ params, searchParams }: Props) {
  const [{ contentId: rawId }, sp] = await Promise.all([params, searchParams]);
  const contentId = parseContentId(rawId);
  if (contentId === null) notFound();

  // URL 파라미터 우선, 없으면 쿠키에 기억된 조건 (첫 화면에서 저장됨)
  const profile =
    sp.profile !== undefined
      ? parseProfile(sp.profile)
      : ((await savedProfile()) ?? "default");
  const transport = parseTransport(sp.tr) ?? (await savedTransport()) ?? "transit";

  // 날짜 모드: D+1~3 예보 / D+4~ 계절 범위. 계산 불가면 오늘 모드 유지.
  // 기간 모드(?date=&end=): 일자별 점수 중 최악일이 대표 — 계산 불가면 단일/오늘로 폴백.
  // URL 파라미터 우선, 없으면 기억된 날짜 (검색·목록에서 고른 날짜가 상세까지 따라온다)
  // 날짜와 기간은 한 출처에서 — 섞으면 단일 날짜 요청에 남은 hari_end가 붙어 기간 모드가 된다
  const dateFromUrl = sp.date !== undefined;
  const { start: date, end } = parseDateRange(
    dateFromUrl ? sp.date : await savedDate(),
    dateFromUrl ? sp.end : await savedEnd(),
  );

  const place = await getPlaceWithSafety(contentId, profile);
  if (!place) {
    // 숙박은 메인 데이터셋에 없다 — 별도 데이터셋에서 찾아 숙박 전용 화면으로
    const lodging = await getLodgingWithSafety(contentId, profile);
    if (lodging) {
      return (
        <>
          <PrefsPersist
            profile={profile}
            transport={transport}
            date={sp.date !== undefined ? (date ?? null) : undefined}
            end={sp.date !== undefined ? (end ?? null) : undefined}
          />
          <LodgingDetail
            lodging={lodging}
            profile={profile}
            date={date}
            end={end}
          />
        </>
      );
    }
    notFound();
  }
  const rangeSafety =
    date && end ? await getRangeSafety(place, profile, date, end) : null;
  const dateSafety = rangeSafety
    ? rangeSafety.worst
    : date
      ? await getDateSafety(place, profile, date)
      : null;
  const activeDate = dateSafety ? date : undefined;
  const activeEnd = rangeSafety ? end : undefined;

  // 대표 점수(랭킹·대체지 비교 기준): 오늘 점수 또는 날짜/최악일 점수(계절은 통상일)
  const safety = dateSafety ? dateSafety.breakdown : place.safety;
  // 분석 섹션(카테고리 소계·요인 상세) 기준: 계절 모드는 궂은날 — "무엇을 주의할지"가 목적.
  // 기간 모드에서도 최악일에 같은 규칙을 적용한다 (단일 날짜와 동일 관계).
  const analysisSafety = dateSafety?.seasonal ? dateSafety.seasonal.bad : safety;

  // 대체지 추천: 전체 후보(요청 스코프 캐시로 재로드 비용 없음)에서 30km 이내 더 안전한 곳.
  // 날짜/기간 모드에서는 후보도 같은 기준으로 계산해 공정하게 비교한다.
  // 사진 갤러리(detailImage2)·후기(네이버)는 느린 외부 API라 Suspense로 스트리밍한다.
  const candidates =
    activeDate && activeEnd
      ? await getPlacesWithSafetyOnRange(profile, activeDate, activeEnd)
      : activeDate
        ? await getPlacesWithSafetyOnDate(profile, activeDate)
        : await getPlacesWithSafety(undefined, profile);

  // 자차는 후보 반경 확대 (대체지 30→50km, 코스 ×1.5) — 직선거리 기준 후보 추리기
  const altMaxKm = transport === "car" ? CAR_DISTANCE_KM : undefined;
  // 화면 문구용 실제 반경 — 안내문과 "못 찾았어요" 문구가 같은 숫자를 말해야 한다
  const altRangeKm = altMaxKm ?? MAX_DISTANCE_KM;
  const alternatives = recommendAlternatives(
    { ...place, safety },
    candidates,
    undefined,
    altMaxKm,
  );

  // 안전 반나절 코스: 앵커(target 또는 대체지 1순위) + 음식점 + 관광지·문화시설
  const course = buildHalfDayCourse(
    { ...place, safety },
    alternatives,
    candidates,
    transport === "car" ? 1.5 : 1,
  );

  const summary = summaryOf(place.contentId);
  const kids = kidsInfoOf(place.contentId);
  const kidsAmenities = kids ? kidsAmenityLabels(kids) : [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PrefsPersist
        profile={profile}
        transport={transport}
        date={sp.date !== undefined ? (date ?? null) : undefined}
        end={sp.date !== undefined ? (end ?? null) : undefined}
      />
      <Link
        href={`/places${buildQuery({ profile: profileParam(profile) })}`}
        className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 transition-colors hover:text-teal-700"
      >
        <span aria-hidden="true">←</span> 목록으로
      </Link>

      {/* ── 전폭 헤더: 뱃지·이름·주소 ── */}
      <div className="mt-4 flex flex-wrap gap-1.5">
        <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-semibold text-teal-700 ring-1 ring-teal-200">
          {placeTypeLabel(place)}
        </span>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
          {ENV_TYPE_LABEL[place.envType]}
        </span>
      </div>
      <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
        {place.title}
      </h1>
      <p className="mt-1.5 text-sm text-slate-500 sm:text-base">
        {place.addr}
        {place.tel && <span className="ml-2 text-slate-400">{place.tel}</span>}
      </p>

      {/* 행동 버튼 — 따라다니는 레일이 없으므로 헤더 바로 아래 전폭에 둔다 (스크롤 없이 담기) */}
      <div className="mt-4 flex flex-wrap gap-2">
        <AddToPlanButton
          item={{
            contentId: place.contentId,
            title: place.title,
            lat: place.lat,
            lng: place.lng,
            score: safety.score,
          }}
          contentTypeId={place.contentTypeId}
        />
        <Link
          href={`/places/${place.contentId}/report${buildQuery({ profile: profileParam(profile) })}`}
          className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-4 py-1.5 text-sm font-semibold text-teal-700 ring-1 ring-teal-200 transition-colors hover:bg-teal-100"
        >
          <span aria-hidden="true">📋</span> 출발 전 체크 리포트
        </Link>
        <a
          href={`https://search.naver.com/search.naver?query=${encodeURIComponent(place.title)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-100"
        >
          <span aria-hidden="true">🔍</span> 네이버에서 자세히 보기
        </a>
        <a
          href={`https://map.kakao.com/link/to/${encodeURIComponent(place.title)},${place.lat},${place.lng}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-100"
        >
          <span aria-hidden="true">🧭</span> 길찾기 (실제 소요시간)
        </a>
      </div>

      {/*
        본문 — 좌: 이 점수 이야기(사진 → 점수 → 근거) / 우: 이 장소 이야기(요약·소개·지도·후기·동행).
        사진이 전폭이던 시절엔 1152×320의 납작한 띠라 원본 위아래가 크게 잘리고,
        그 띠가 본문을 통째로 아래로 밀어냈다. 절반 컬럼(≈544px) + 3:2로 바꾸면
        잘림이 10% 내외로 줄고 남는 오른쪽이 첫 화면 정보량이 된다.

        ⚠ 그리드를 **하나만** 쓴다. 예전엔 상단(사진|지도)·하단(근거|후기)으로 그리드가
        둘이었는데, 두 컬럼 높이가 같을 리 없어 이음매마다 구멍이 났다
        (실측: 사진+점수 594px vs 요약+소개+지도 416px → 지도 아래 178px 공백).
        컬럼당 그리드 자식을 하나로 두면 두 컬럼이 각자 흐르므로 중간 구멍이 사라지고,
        남는 여백은 짧은 컬럼 맨 끝 한 곳에만 모인다.
        min-w-0: 그리드 자식의 min-width:auto가 내부 가로 스크롤러(썸네일 스트립)를
        밀어내 페이지 전체가 가로로 넘치는 것을 막는다 — 자식마다 필요하다.
        items-start: 없으면 셀이 stretch돼 짧은 쪽 카드가 세로로 늘어난다.
      */}
      <div className="mt-6 grid gap-8 lg:grid-cols-2 lg:items-start">
        <div className="min-w-0 space-y-6">
          {/* 대표사진 즉시, detailImage2 추가 사진은 스트리밍 */}
          <div>
            <Suspense
              fallback={
                <PlaceGallery
                  title={place.title}
                  envType={place.envType}
                  images={place.imageUrl ? [place.imageUrl] : []}
                  ratio="half"
                />
              }
            >
              <GallerySection
                contentId={contentId}
                title={place.title}
                envType={place.envType}
                imageUrl={place.imageUrl}
                ratio="half"
              />
            </Suspense>
          </div>

          {/*
            안전 점수 요약 — 사진 바로 아래.
            사진만으로는 왼쪽 컬럼이 짧아 밑이 비었다. 그 자리를 페이지의 핵심 숫자가
            채우면 빈칸이 사라지고 점수가 첫 화면 안에 들어온다.
            점수·등급·동행 조건을 한 카드에 묶은 이유: 이전에는 세 덩어리로 흩어져 있어
            "몇 점인지"를 알기까지 세 번 시선을 옮겨야 했다.
          */}
          {/* 테두리는 단일 점수일 때만 등급색. 계절 모드는 통상일·궂은날 두 점수를
              같이 보여주므로, 한 등급색으로 칠하면 나머지 하나를 잘못 대변한다
              (통상일 낮음 + 궂은날 높음인데 카드가 초록으로 보이는 문제) */}
          <div
            className={`rounded-2xl bg-white p-4 ring-1 ${
              dateSafety?.seasonal
                ? "ring-slate-200"
                : GRADE_STYLE[safety.grade].ring
            }`}
          >
            {dateSafety?.seasonal ? (
              /* 계절 모드: 개별 날짜 예보가 없어 단일 점수를 단정하지 않고 범위로 안내 */
              <>
                <p className="text-xs font-medium text-slate-500">
                  {rangeSafety
                    ? `기간 중 가장 주의가 필요한 날(${formatKoreanDate(dateSafety.dateISO)}) 기준 — `
                    : `${formatKoreanDate(dateSafety.dateISO)} 방문 — `}
                  {dateSafety.seasonal.month}월 · 30년 기후 기준
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div>
                    <p className="text-xs font-semibold text-slate-400">통상일</p>
                    <SafetyScoreBadge
                      score={dateSafety.seasonal.typical.score}
                      grade={dateSafety.seasonal.typical.grade}
                    />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-slate-400">궂은날</p>
                    <SafetyScoreBadge
                      score={dateSafety.seasonal.bad.score}
                      grade={dateSafety.seasonal.bad.grade}
                    />
                  </div>
                </div>
                {/* "30년 기후"는 첫 줄에 이미 있으므로 여기선 범위의 의미만 설명한다 */}
                <p className="mt-2 text-xs leading-relaxed text-slate-400">
                  먼 날짜는 날씨를 예보할 수 없어, 평범한 날과 궂은 날(상위 10%)의
                  점수 범위로 안내해요.
                </p>
              </>
            ) : (
              <div className="flex items-center gap-3.5">
                <p className="flex shrink-0 items-baseline gap-0.5">
                  <span
                    className={`text-4xl font-extrabold tabular-nums ${GRADE_STYLE[safety.grade].text}`}
                  >
                    {safety.score}
                  </span>
                  <span className="text-xs font-medium text-slate-400">/ 100</span>
                </p>
                <div className="min-w-0">
                  <p
                    className={`flex items-center gap-1.5 font-bold ${GRADE_STYLE[safety.grade].text}`}
                  >
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${GRADE_STYLE[safety.grade].dot}`}
                    />
                    {GRADE_LABEL[safety.grade]}
                  </p>
                  <p className="text-xs text-slate-500">
                    {dateSafety
                      ? rangeSafety
                        ? `기간 중 가장 주의가 필요한 날(${formatKoreanDate(dateSafety.dateISO)}) 예보 기준`
                        : `${formatKoreanDate(dateSafety.dateISO)} 예보 기준`
                      : "오늘의 안전 점수"}
                  </p>
                </div>
              </div>
            )}

            {/* 감점 내역은 아래 "왜 이 점수인가요?"가 전부 펼친다 —
                여기 한 줄 요약을 두면 총점(100 − 총감점)을 같은 말로 두 번 쓰게 된다 */}
            {dateSafety?.mode === "forecast" && (
              <p className="mt-1.5 text-xs text-slate-400">
                기상은 {dateSafety.dayOffset}일 후 예보, 미세먼지·산불위험은 현재값
                기준입니다.
              </p>
            )}
            {/* 기간 일자별 점수 — 셀 클릭 시 그날 단일 날짜로 드릴다운 */}
            {rangeSafety && (
              <div className="mt-3">
                <RangeDayStrip
                  range={rangeSafety}
                  basePath={`/places/${place.contentId}`}
                  extraParams={{ profile: profileParam(profile) }}
                />
              </div>
            )}

            {/* 동행 조건 — 점수를 바꾸는 입력이므로 점수와 같은 카드에 둔다 */}
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-slate-100 pt-3">
              <span className="text-xs font-semibold text-slate-500">
                동행에 따라 달라져요 —{" "}
                <strong className="text-teal-700">
                  {PROFILE_LABEL[profile]} 기준
                </strong>
              </span>
              <ProfileChips
                basePath={`/places/${place.contentId}`}
                current={profile}
                extraParams={{ date: activeDate, end: activeEnd }}
              />
            </div>
          </div>

          {/* 요인별 상세 — 계절 모드는 궂은날 시나리오 기준 (무엇을 주의할지) */}
          <section>
            <h2 className="text-lg font-bold text-slate-900">
              {dateSafety?.seasonal
                ? "궂은날엔 이런 점을 주의하세요"
                : "왜 이 점수인가요?"}
            </h2>
            <div className="mt-3">
              <RiskBreakdownBar factors={analysisSafety.factors} />
            </div>
          </section>

          {/* 추천 반나절 코스 — 점수 해설 바로 아래.
              별도 행에 두면 왼쪽 컬럼이 오른쪽(요약+소개+지도+후기)보다 짧아
              그 사이에 빈 띠가 생긴다. 같은 컬럼에 이어 붙이면 여백이 사라지고,
              "이 점수라서 이 코스"라는 읽는 순서도 맞는다. */}
          {course && (
            <section>
              <h2 className="text-lg font-bold text-slate-900">
                추천 반나절 코스
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {course.anchoredOnAlternative
                  ? `오늘은 ${place.title} 대신 더 안전한 코스를 추천해요`
                  : `${place.title}에서 시작하는 안전 코스예요`}
              </p>
              <CourseTimeline course={course} profile={profile} />
            </section>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          {/* AI 3줄 요약 — 사진 옆 첫 문장으로 "어떤 곳인지" 즉시 파악 */}
          {summary && (
            <div className="rounded-xl bg-sky-50/60 px-4 py-3 ring-1 ring-sky-100">
              <p className="text-xs font-bold text-sky-700">
                ⚡ 핵심 3줄
                <span className="ml-1.5 font-medium text-sky-400">AI 요약</span>
              </p>
              <ul className="mt-1 space-y-0.5 text-sm leading-relaxed text-slate-700">
                {summary.map((line) => (
                  <li key={line}>· {line}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 소개 — TourAPI detailCommon2 실시간 조회 (스트리밍, 없으면 숨김) */}
          <Suspense fallback={null}>
            <OverviewSection contentId={contentId} fallback={place.overview} />
          </Suspense>

          {/* 위치 지도 */}
          <section>
            <h2 className="text-lg font-bold text-slate-900">위치 보기</h2>
            {/* 마커가 하나뿐이면 범례가 설명할 게 없다 — 대체지가 있을 때만 */}
            {alternatives.length > 0 && (
              <p className="mt-1 text-sm text-slate-500">
                <span className="font-semibold text-teal-800">●</span> 현재
                관광지 · <span className="font-semibold text-emerald-500">●</span>{" "}
                더 안전한 대체지
              </p>
            )}
            <div className="mt-3">
              <PlaceMap
                target={{
                  contentId: place.contentId,
                  title: place.title,
                  lat: place.lat,
                  lng: place.lng,
                  score: safety.score,
                }}
                alternatives={alternatives.map((alt) => ({
                  contentId: alt.contentId,
                  title: alt.title,
                  lat: alt.lat,
                  lng: alt.lng,
                  score: alt.safety.score,
                  distanceKm: alt.distanceKm,
                }))}
                profileQuery={buildQuery({
                  profile: profileParam(profile),
                  date: activeDate,
                  end: activeEnd,
                })}
              />
            </div>
          </section>

          {/* 방문 후기 (스트리밍, 후기 없으면 섹션 숨김) */}
          <Suspense fallback={null}>
            <ReviewsSection title={place.title} />
          </Suspense>

          {/* 반려동물 동반 정보 — detailPetTour2 실시간 (없으면 숨김) */}
          <Suspense fallback={null}>
            <PetSection contentId={contentId} />
          </Suspense>

          {/* 유아 동반 편의시설 — 한국문화정보원 데이터 (없으면 숨김) */}
          {kids && (
            <section>
              <h2 className="text-lg font-bold text-slate-900">
                👶 아이와 함께
              </h2>
              <div className="mt-2 rounded-xl bg-white p-4 text-sm leading-relaxed text-slate-600 ring-1 ring-slate-200">
                {kidsAmenities.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {kidsAmenities.map((a) => (
                      <span
                        key={a}
                        className="rounded-full bg-pink-50 px-2.5 py-0.5 text-xs font-semibold text-pink-700 ring-1 ring-pink-200"
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                )}
                {kids.age && (
                  <p className={kidsAmenities.length > 0 ? "mt-2" : ""}>
                    <span className="font-semibold text-slate-700">입장 가능 나이: </span>
                    {kids.age}
                  </p>
                )}
                <p className="mt-2 text-xs text-slate-400">
                  한국문화정보원 유아 동반 시설 데이터 (2022년 조사 기준) —
                  방문 전 시설에 확인을 권장해요.
                </p>
              </div>
            </section>
          )}
        </div>
      </div>

      {/* 안전한 대체지 추천 — 코스가 위 컬럼으로 올라가 이 행은 대체지 단독,
          전체 폭이므로 최대 4장을 한 줄에 놓는다 */}
      <div className="mt-8">
        <section className="min-w-0">
          <h2 className="text-lg font-bold text-slate-900">안전한 대체지 추천</h2>
          <p className="mt-1 text-sm text-slate-500">
            같은 유형의 더 안전한 주변 관광지예요 —{" "}
            {transport === "car" ? "자차" : "대중교통"} 기준 {altRangeKm}km 이내
            (직선거리)
          </p>
          {alternatives.length === 0 ? (
            <div className="mt-3 rounded-2xl bg-teal-50/50 px-6 py-10 text-center ring-1 ring-teal-100">
              <p className="text-3xl" aria-hidden="true">
                🧭
              </p>
              <p className="mt-3 font-bold text-slate-700">
                이 관광지는 주변 대비 이미 주의 요인이 낮은 편이에요
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {altRangeKm}km 이내에서 안전 점수가 의미 있게 더 높은 관광지를
                찾지 못했어요.
              </p>
              <Link
                href={`/places${buildQuery({ profile: profileParam(profile) })}`}
                className="mt-4 inline-block rounded-full bg-teal-50 px-4 py-1.5 text-sm font-semibold text-teal-700 ring-1 ring-teal-200 transition-colors hover:bg-teal-100"
              >
                다른 관광지 둘러보기
              </Link>
            </div>
          ) : (
            <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {alternatives.map((alt) => (
                <PlaceCard
                  key={alt.contentId}
                  place={alt}
                  profile={profile}
                  date={activeDate}
                  end={activeEnd}
                  footer={
                    <p className="text-xs font-semibold text-teal-700">
                      직선 {alt.distanceKm.toFixed(1)}km · 도로 약{" "}
                      {roadKm(alt.distanceKm).toFixed(1)}km · 안전점수 +
                      {alt.safety.score - safety.score}점
                    </p>
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>
      {/* 면책 문구는 전역 푸터(layout.tsx)에 있다 — 여기 두면 바로 위아래로 두 번 나온다 */}
    </div>
  );
}
