"use client";

import Link from "next/link";
import type { RegionSummary } from "@/lib/risk/region-summary";
import { GRADE_LABEL } from "@/lib/safety/types";
import SafetyScoreBadge from "@/components/SafetyScoreBadge";
import RiskBreakdownBar from "@/components/RiskBreakdownBar";

/** 산사태 예보발령 단계 라벨 (0 없음 · 1 주의보 · 2 경보) */
const LANDSLIDE_ALERT_LABEL = ["", "주의보", "경보"] as const;

interface RegionPanelProps {
  regions: RegionSummary[];
  selectedCode: number | null;
  onSelect: (sigunguCode: number) => void;
  onClear: () => void;
  /** 점수 기준 라벨 (기본 "오늘", 날짜 모드에서 "7월 20일 (월)" 등) */
  dateLabel?: string;
  /** 목록/코스 링크에 유지할 조건 (profile=..., date=...) */
  extraQuery?: Record<string, string | undefined>;
}

/** 대시보드 우측 패널 — 선택 전: 시군 리스트 / 선택 후: 시군 상세 */
export default function RegionPanel({
  regions,
  selectedCode,
  onSelect,
  onClear,
  dateLabel = "오늘",
  extraQuery = {},
}: RegionPanelProps) {
  const selected = regions.find((r) => r.sigunguCode === selectedCode);

  function hrefWith(base: string, sigunguCode: number): string {
    const q = new URLSearchParams({ sigungu: String(sigunguCode) });
    for (const [k, v] of Object.entries(extraQuery)) {
      if (v) q.set(k, v);
    }
    return `${base}?${q.toString()}`;
  }

  if (selected) {
    return (
      <aside className="flex flex-col rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <button
          type="button"
          onClick={onClear}
          className="self-start text-xs font-semibold text-slate-400 transition-colors hover:text-teal-700"
        >
          ← 전체 시군 보기
        </button>
        <h2 className="mt-3 text-xl font-extrabold text-slate-900">
          {selected.name}
        </h2>
        <div className="mt-2">
          {selected.medianScore !== null && selected.grade !== null ? (
            <div className="space-y-1.5">
              <SafetyScoreBadge
                score={selected.medianScore}
                grade={selected.grade}
              />
              <p className="text-xs text-slate-500">
                {dateLabel} 기준 {GRADE_LABEL[selected.grade]} — 야외 관광지 기준으로
                아래 지표 감점을 합산한 시군 대표 점수입니다.
              </p>
              {/* 계절에 따라 18개 시군이 통째로 같은 등급에 들어가는 날이 흔하다.
                  그럴 때 등급만으로는 시군을 비교할 수 없어 상대 순위를 함께 보인다 */}
              {selected.rank !== null && (
                <p className="text-xs font-semibold text-slate-600">
                  강원 {selected.rankedTotal}개 시군 중{" "}
                  <strong className="tabular-nums text-teal-700">
                    {selected.rank}번째
                  </strong>
                  로 안전
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              {dateLabel} 점수를 계산할 관광지 데이터가 없습니다.
            </p>
          )}
        </div>
        <p className="mt-4 text-sm text-slate-600">
          등록 관광지{" "}
          <strong className="tabular-nums text-slate-900">
            {selected.placeCount}곳
          </strong>
        </p>

        {selected.landslideAlert > 0 && (
          <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
            ⚠️ 산사태 {LANDSLIDE_ALERT_LABEL[selected.landslideAlert]} 발령 중 (산림청)
          </div>
        )}

        {/* 왜 이 점수인가 — 안전지수 산출 지표 시각화 (대표 관광지 기준) */}
        {selected.factors.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <p className="mb-1 text-sm font-bold text-slate-800">
              이 점수는 왜?
            </p>
            <p className="mb-3 text-xs text-slate-400">
              날씨·산불·산사태는 시군 대표 야외지
              {selected.sampleName ? `(${selected.sampleName})` : ""} 기준 · 응급의료는
              시군 중앙값
            </p>
            <RiskBreakdownBar factors={selected.factors} compact />
          </div>
        )}

        <div className="mt-5 flex flex-col gap-2">
          <Link
            href={hrefWith("/places", selected.sigunguCode)}
            className="rounded-xl bg-teal-600 px-4 py-2.5 text-center text-sm font-bold text-white transition-colors hover:bg-teal-700"
          >
            {selected.name} 관광지 보기
          </Link>
        </div>
      </aside>
    );
  }

  const renderItem = (region: RegionSummary) => (
    <li key={region.sigunguCode}>
      <button
        type="button"
        onClick={() => onSelect(region.sigunguCode)}
        className="flex w-full items-center justify-between gap-2 px-5 py-2.5 text-left transition-colors hover:bg-teal-50/60"
      >
        {/* 순위를 앞에 둔다 — 등급이 전부 같은 날에도 목록이 서열 정보를 준다 */}
        <span className="w-6 shrink-0 text-xs font-bold tabular-nums text-slate-400">
          {region.rank !== null ? region.rank : "–"}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">
          {region.name}
          <span className="ml-2 text-xs font-normal text-slate-400">
            관광지 {region.placeCount}곳
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {region.landslideAlert > 0 && (
            <span
              className={`text-sm ${region.landslideAlert >= 2 ? "opacity-100" : "opacity-60"}`}
              title={`산사태 ${LANDSLIDE_ALERT_LABEL[region.landslideAlert]} 발령 중 (산림청)`}
              aria-label={`산사태 ${LANDSLIDE_ALERT_LABEL[region.landslideAlert]} 발령`}
            >
              ⚠️
            </span>
          )}
          {region.medianScore !== null && region.grade !== null ? (
            <SafetyScoreBadge score={region.medianScore} grade={region.grade} />
          ) : (
            <span className="text-xs font-semibold text-slate-400">데이터 없음</span>
          )}
        </span>
      </button>
    </li>
  );

  return (
    <aside className="flex flex-col rounded-2xl bg-white ring-1 ring-slate-200">
      <p className="border-b border-slate-100 px-5 py-3 text-sm font-bold text-slate-900">
        시군별 요약
        <span className="ml-2 text-xs font-medium text-slate-400">
          점수 높은 시군부터 · 지도나 목록에서 선택
        </span>
      </p>
      <ul className="max-h-[440px] divide-y divide-slate-100 overflow-y-auto">
        {regions.map(renderItem)}
      </ul>
    </aside>
  );
}
