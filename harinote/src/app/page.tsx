import { Suspense } from "react";
import { getRegionSummaries } from "@/lib/risk/region-summary";
import FestivalSection from "@/components/FestivalSection";
import { hasLiveRiskKeys } from "@/lib/risk/live";
import { hasForestKey } from "@/lib/risk/forest";
import { medicalDataSource } from "@/lib/risk/medical";
import { addDaysISO, formatKoreanDate, todayISOSeoul } from "@/lib/date";
import SearchBox from "@/components/SearchBox";
import DateStepper from "@/components/DateStepper";
import RegionDashboard from "@/components/RegionDashboard";
import {
  parseDate,
  parseProfile,
  parseTransport,
  profileParam,
  type SearchParamValue,
} from "@/components/search-params";
import { savedProfile, savedTransport, type Transport } from "@/lib/prefs";
import PrefsPersist from "@/components/PrefsPersist";

interface Props {
  searchParams: Promise<Record<string, SearchParamValue>>;
}

export default async function Home({ searchParams }: Props) {
  const sp = await searchParams;
  // URL 파라미터 우선, 없으면 쿠키에 기억된 조건 (한 번 고르면 다음 방문에도 유지)
  const profile =
    sp.profile !== undefined
      ? parseProfile(sp.profile)
      : ((await savedProfile()) ?? "default");
  const transport: Transport =
    parseTransport(sp.tr) ?? (await savedTransport()) ?? "transit";
  // 단일 날짜 모드 — 단기예보 실측 범위(오늘~D+3)로 클램프 (getDateSafety 실예보 분기와 일치)
  const todayISO = todayISOSeoul();
  const maxISO = addDaysISO(todayISO, 3);
  const parsed = parseDate(sp.date);
  const date = parsed && parsed > maxISO ? maxISO : parsed;

  // 선택한 조건(언제·누구와)이 지도·시군 요약에 바로 반영된다
  const regions = await getRegionSummaries(profile, date);
  const dateLabel = date ? formatKoreanDate(date) : "오늘";

  return (
    <div className="bg-gradient-to-b from-teal-50/60 to-slate-50">
      <div className="mx-auto max-w-6xl px-4 pb-10 pt-8">
        {/* 컴팩트 히어로 */}
        <div className="max-w-2xl">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
            {date ? `${dateLabel}, ` : "오늘, "}이 강원 관광지 가도 될까?
          </h1>
          <p className="mt-1.5 text-sm text-slate-600 sm:text-base">
            기상·재난·의료 공공데이터로 관광지별 방문 주의 요인을 점수로
            알려드립니다.
          </p>
          {/* 모바일 검색 (md+는 네비바 전역 검색 사용) */}
          <div className="mt-4 md:hidden">
            <SearchBox profile={profile} date={date} />
          </div>

          {/* 날짜는 여기서만 "고른다" — URL에 date가 실려 온 경우(스테퍼 조작)만 기억을
              갱신하고, 오늘을 고르면 null로 넘겨 기억을 지운다. 탭으로 그냥 들른 진입은
              undefined라 손대지 않는다 — 안 그러면 지도에 한 번 들르는 것만으로 날짜가 사라진다 */}
          <PrefsPersist
            profile={profile}
            transport={transport}
            date={sp.date !== undefined ? (date ?? null) : undefined}
          />

          {/* 날짜 스테퍼 — 원하는 날(오늘~D+3)의 안전지수를 지도에서 바로 확인 */}
          <DateStepper
            current={date}
            todayISO={todayISO}
            maxISO={maxISO}
            extraParams={{ profile: profileParam(profile) }}
          />
        </div>

        {/* 안전 지도 대시보드 — 선택 조건 기준 */}
        <section className="mt-6" aria-label={`${dateLabel} 안전 지도`}>
          <RegionDashboard
            regions={regions}
            dateLabel={dateLabel}
            extraQuery={{ profile: profileParam(profile), date }}
          />
        </section>

        {/* 축제·행사 — TourAPI 실시간, 등록 없으면 숨김 (스트리밍) */}
        <Suspense fallback={null}>
          <FestivalSection dateISO={date} profile={profile} />
        </Suspense>

        {/* 출처·참고 */}
        <footer className="mt-8 border-t border-slate-200 pt-3 text-xs leading-relaxed text-slate-400">
          <p>
            본 지도는 공공데이터 기반 참고 정보이며 안전을 보장하지 않습니다.
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
      </div>
    </div>
  );
}
