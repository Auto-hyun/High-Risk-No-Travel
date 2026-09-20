"use client";

/**
 * 테마 코스 카드 — 오전→점심→오후 타임라인 + 루트 지도 + 스톱별 대안 교체 칩.
 * 서버가 만든 얇은 DTO(ThemedCourseDto)만 받는다 (datasource import 금지).
 * 대안 칩을 누르면 해당 스톱이 교체되고 지도 루트·이동거리를 다시 계산한다.
 */
import { useState } from "react";
import Link from "next/link";
import {
  COURSE_THEME_META,
  type CoursePlaceDto,
  type CourseSlot,
  type ThemedCourseDto,
} from "@/lib/course/themed";
import { GRADE_LABEL, type Profile, type RiskLevel } from "@/lib/safety/types";
import { haversineKm, roadKm } from "@/lib/reco/distance";
import { buildQuery, profileParam } from "@/components/search-params";
import CourseRouteMap from "@/components/CourseRouteMap";
import { useTravelPlan } from "@/hooks/useTravelPlan";

const SLOT_META: Record<CourseSlot, { emoji: string; label: string }> = {
  morning: { emoji: "☀️", label: "오전" },
  lunch: { emoji: "🍽️", label: "점심" },
  afternoon: { emoji: "🌤️", label: "오후" },
};

const GRADE_TEXT: Record<RiskLevel, string> = {
  low: "text-emerald-700",
  moderate: "text-amber-700",
  high: "text-red-700",
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

interface Props {
  course: ThemedCourseDto;
  profile: Profile;
  /** 계획에 담은 뒤 호출 (팝업이 모달을 닫는 용도) */
  onAdded?: () => void;
}

export default function CourseCard({ course, profile, onAdded }: Props) {
  const meta = COURSE_THEME_META[course.theme];
  const query = buildQuery({ profile: profileParam(profile) });

  // 스톱별 선택 인덱스: 0 = 추천 스톱, k>0 = alternates[k-1]
  const [selected, setSelected] = useState<number[]>(() =>
    course.stops.map(() => 0),
  );

  const chosen: CoursePlaceDto[] = course.stops.map((stop, i) =>
    selected[i] === 0 ? stop.place : stop.alternates[selected[i] - 1],
  );

  // 선택 조합 기준 구간 거리 재계산
  const legs = chosen.map((place, i) =>
    i === 0
      ? undefined
      : round1(
          haversineKm(chosen[i - 1].lat, chosen[i - 1].lng, place.lat, place.lng),
        ),
  );
  const totalKm = round1(legs.reduce<number>((sum, km) => sum + (km ?? 0), 0));

  const toggleAlternate = (stopIdx: number, altIdx: number) => {
    setSelected((prev) =>
      prev.map((v, i) =>
        // 이미 선택된 대안을 다시 누르면 추천 스톱으로 복귀
        i === stopIdx ? (v === altIdx + 1 ? 0 : altIdx + 1) : v,
      ),
    );
  };

  // 현재 선택 조합을 내 여행 계획의 활성 일차에 일괄 담기
  const { addMany, activeDay, has } = useTravelPlan();
  const [added, setAdded] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // 이미 계획에 있는 스톱은 addItem이 조용히 건너뛴다 — 몇 곳이 빠졌는지 알려주지 않으면
  // "✓ 담았어요" + 모달 닫힘만 보고 전부 담긴 줄 안다
  const [skipped, setSkipped] = useState(0);
  const addCourseToPlan = () => {
    const dupes = chosen.filter((p) => has(p.contentId)).length;
    if (dupes === chosen.length) {
      // 담을 게 하나도 없다 — 저장도 성공 표시도 하지 않고 이유만 알린다
      setSkipped(dupes);
      setTimeout(() => setSkipped(0), 3000);
      return;
    }
    // 저장 실패(쿼터·저장소 차단) 시 write()가 false — 성공 표시·모달 닫기를 막는다
    const ok = addMany(
      // 코스의 슬롯(오전/점심/오후)을 계획에도 그대로 보존한다
      chosen.map((p, i) => ({ contentId: p.contentId, title: p.title, lat: p.lat, lng: p.lng, score: p.score, slot: course.stops[i].slot })),
      activeDay,
    );
    if (!ok) {
      setSaveFailed(true);
      setTimeout(() => setSaveFailed(false), 2000);
      return;
    }
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
    if (dupes > 0) {
      // 일부만 담겼으면 모달을 닫지 않는다 — 닫으면 누락 안내가 보이기도 전에 사라진다
      setSkipped(dupes);
      setTimeout(() => setSkipped(0), 3000);
      return;
    }
    onAdded?.();
  };

  return (
    <article className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
      {/* 테마 헤더 */}
      <div className="flex items-start gap-3">
        <span className="text-3xl" aria-hidden="true">
          {meta.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-extrabold text-slate-900">
            {meta.label}
          </h3>
          <p className="text-sm text-slate-500">{meta.desc}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <p className="text-sm font-semibold text-slate-600">
            총 이동 약 {roadKm(totalKm).toFixed(1)}km (도로 추정)
          </p>
          <button
            type="button"
            onClick={addCourseToPlan}
            className={`rounded-full px-3 py-1 text-xs font-bold transition-colors ${
              added
                ? "bg-teal-600 text-white"
                : saveFailed
                  ? "bg-red-50 text-red-700 ring-1 ring-red-200"
                  : "bg-teal-50 text-teal-700 ring-1 ring-teal-200 hover:bg-teal-100"
            }`}
          >
            {added ? "✓ 담았어요" : saveFailed ? "저장 못 했어요" : "+ 내 계획에 담기"}
          </button>
          {skipped > 0 && (
            <p className="max-w-[13rem] text-right text-[11px] font-semibold text-amber-700">
              {skipped === chosen.length
                ? "이 코스는 이미 계획에 담겨 있어요"
                : `이미 담긴 ${skipped}곳은 빼고 담았어요`}
            </p>
          )}
        </div>
      </div>

      {/* 타임라인 */}
      <ol className="mt-4">
        {course.stops.map((stop, i) => {
          const place = chosen[i];
          const slot = SLOT_META[stop.slot];
          return (
            <li key={stop.slot}>
              {legs[i] !== undefined && (
                <p className="my-1.5 ml-5 flex items-center gap-2 text-xs font-semibold text-slate-400">
                  <span aria-hidden="true">↓</span> {legs[i]!.toFixed(1)}km 이동
                </p>
              )}
              <div className="flex items-start gap-3 rounded-xl bg-slate-50/60 p-3 ring-1 ring-slate-100">
                <div className="flex w-10 shrink-0 flex-col items-center">
                  <span className="text-lg" aria-hidden="true">
                    {slot.emoji}
                  </span>
                  <span className="text-xs font-bold text-slate-500">
                    {slot.label}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/places/${place.contentId}${query}`}
                    className="text-sm font-bold text-slate-900 hover:text-teal-700"
                  >
                    {place.title}
                  </Link>
                  <p
                    className={`mt-0.5 text-xs font-semibold ${GRADE_TEXT[place.grade]}`}
                  >
                    <span className="tabular-nums">{place.score}점</span> ·{" "}
                    {GRADE_LABEL[place.grade]}
                  </p>
                  {stop.alternates.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {stop.alternates.map((alt, altIdx) => {
                        const pressed = selected[i] === altIdx + 1;
                        return (
                          <button
                            key={alt.contentId}
                            type="button"
                            aria-pressed={pressed}
                            onClick={() => toggleAlternate(i, altIdx)}
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition-colors ${
                              pressed
                                ? "bg-teal-600 text-white ring-teal-600"
                                : "bg-white text-slate-600 ring-slate-200 hover:bg-teal-50 hover:text-teal-700"
                            }`}
                          >
                            <span aria-hidden="true">⇄</span>
                            <span className="max-w-36 truncate">
                              {alt.title}
                            </span>
                            <span className="tabular-nums">{alt.score}점</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {/* 루트 지도 — 선택 조합 기준 */}
      <div className="mt-4">
        <CourseRouteMap
          stops={chosen.map((p) => ({
            title: p.title,
            lat: p.lat,
            lng: p.lng,
          }))}
        />
      </div>

      <Link
        href={`/places/${chosen[0].contentId}/report${query}`}
        className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-4 py-1.5 text-sm font-semibold text-teal-700 ring-1 ring-teal-200 transition-colors hover:bg-teal-100"
      >
        <span aria-hidden="true">📋</span> 이 코스로 출발 전 체크 →
      </Link>
    </article>
  );
}
