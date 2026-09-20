"use client";

/**
 * 빈 슬롯 채우기 모달 — 플래너 패널에서 열면 담아둔 스톱(앵커)을 그대로 두고
 * 빈 시간 슬롯(오전/점심/오후/저녁/숙소)만 일차별 날짜 점수 기준으로 추천한다.
 * 계획이 비어 있으면 기존 "N박 전체 일정 추천"과 동일 동작 (이때만 시군 선택 필수).
 * "빈 슬롯에 채우기"는 덮어쓰기가 아니라 병합(addMany) — 담아둔 곳은 불변.
 * 동행·이동수단은 검색 필터(여행 조건 패널)에서 자동 상속.
 */
import { useState, useSyncExternalStore, useTransition } from "react";
import { createPortal } from "react-dom";
import { useTravelPlan } from "@/hooks/useTravelPlan";
import CourseSigunguPicker from "@/components/CourseSigunguPicker";
import { courseConditionParts } from "@/components/travel-condition";
import { COURSE_THEME_META, type CourseTheme } from "@/lib/course/themed";
import {
  fillEmptySlots,
  type FillSlotsDto,
  type SlotFillDto,
} from "@/lib/course/fill-slots-action";
import { formatKoreanDate } from "@/lib/date";
import type { Profile } from "@/lib/safety/types";
import type { Transport } from "@/lib/prefs";
import { roadKm } from "@/lib/reco/distance";
import {
  PLAN_SLOTS,
  SLOT_META,
  type PlanItem,
  type PlanSlot,
} from "@/lib/travel-plan";

const GRADE_TEXT: Record<string, string> = {
  low: "text-teal-600",
  moderate: "text-amber-600",
  high: "text-red-600",
};

/** 일차 안에서 앵커(담아둔 곳)와 추천 채움을 슬롯 순서로 섞어 보여주기 위한 행 */
type DayRow =
  | { type: "anchor"; slot: PlanSlot; item: PlanItem }
  | { type: "fill"; slot: PlanSlot; fill: SlotFillDto };

export default function MultiDayCourseModal({
  profile,
  transport,
  sigunguCodes,
}: {
  profile: Profile;
  /** 검색 필터에서 상속 — 자차면 코스 스톱 반경 확대 */
  transport: Transport;
  /** 검색 필터의 시군 복수선택 — 1곳이면 자동 선택, 2곳 이상이면 그룹 우선 표시 */
  sigunguCodes: number[];
}) {
  const { plan, addMany, days, count } = useTravelPlan();
  const [open, setOpen] = useState(false);
  const [sigungu, setSigungu] = useState<number | undefined>();
  const [theme, setTheme] = useState<CourseTheme>("nature");
  const [result, setResult] = useState<FillSlotsDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [isPending, startTransition] = useTransition();
  // SSR에서 document.body를 참조하지 않도록 포털 렌더를 마운트 후로 미룬다
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  const hasAnchors = count > 0;

  const load = (code: number | undefined, t: CourseTheme) => {
    // 앵커가 없으면 1일차 출발 시군이 반드시 필요하다 (서버 검증과 동일 규칙)
    if (!hasAnchors && code === undefined) return;
    startTransition(async () => {
      try {
        const data = await fillEmptySlots({
          anchors: plan.items.map((it) => ({
            contentId: it.contentId,
            day: Math.min(it.day ?? 1, days),
            slot: it.slot ?? "morning",
          })),
          theme: t,
          sigunguCode: code,
          profile,
          days,
          from: plan.from,
          transport,
        });
        setResult(data);
        setFailed(false);
      } catch {
        setResult(null);
        setFailed(true);
      }
    });
  };

  const pick = (code?: number, t?: CourseTheme) => {
    const nextCode = code ?? sigungu;
    const nextTheme = t ?? theme;
    if (code !== undefined) setSigungu(code);
    if (t !== undefined) setTheme(t);
    load(nextCode, nextTheme);
  };

  // 열기: 담긴 곳이 있으면 바로 채우기, 없으면 검색 필터의 단일 시군 자동 선택
  const openModal = () => {
    setOpen(true);
    if (hasAnchors) {
      load(sigungu, theme);
      return;
    }
    if (sigungu === undefined && sigunguCodes.length === 1) {
      setSigungu(sigunguCodes[0]);
      load(sigunguCodes[0], theme);
    }
  };

  const applyToPlan = () => {
    if (!result || result.fills.length === 0) return;
    // 병합 — addMany는 중복 contentId를 스킵하므로 담아둔 곳은 그대로다
    const items: PlanItem[] = result.fills.map((f) => ({
      contentId: f.place.contentId,
      title: f.place.title,
      lat: f.place.lat,
      lng: f.place.lng,
      score: f.place.score,
      day: f.day,
      slot: f.slot,
      ...(f.place.contentTypeId === 32 ? { kind: "lodging" as const } : {}),
    }));
    // 저장 실패(쿼터·저장소 차단) 시 write()가 false — 모달 닫기를 막는다
    const ok = addMany(items, 1);
    if (!ok) {
      setSaveFailed(true);
      setTimeout(() => setSaveFailed(false), 2000);
      return;
    }
    setOpen(false);
  };

  // 일차별 표시 행 — 앵커(담아둔 곳)와 추천을 슬롯 순서로 병치
  const slotOrder = (s: PlanSlot) => PLAN_SLOTS.indexOf(s);
  const rowsOfDay = (d: number): DayRow[] => {
    const rows: DayRow[] = [
      ...plan.items
        .filter((it) => Math.min(it.day ?? 1, days) === d)
        .map((it): DayRow => ({ type: "anchor", slot: it.slot ?? "morning", item: it })),
      ...(result?.fills ?? [])
        .filter((f) => f.day === d)
        .map((f): DayRow => ({ type: "fill", slot: f.slot, fill: f })),
    ];
    return rows.sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot));
  };

  // 옆의 "하루 코스 추천"과 여행 길이 축으로 갈리는 이름. 담긴 곳 유무로 동작은
  // 달라지지만(빈 시간만 채움 / 전체 일정) 이름은 고정한다 — 같은 버튼이 이름을
  // 바꾸면 "그 버튼"으로 기억할 수가 없다.
  // 담아둔 곳이 있을 때 "풀코스"가 덮어쓰기로 읽히지 않게, 아래 부제와 최종 버튼
  // ("빈 시간에 채우기 N곳")이 병합임을 정확히 말한다
  const title = "풀코스 추천";

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="w-full rounded-xl bg-teal-600 px-3 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-teal-700"
      >
        {title}
      </button>

      {/* sticky 패널 안은 스태킹 컨텍스트라 z-50이 갇힌다 — body로 포털 (마운트 후에만) */}
      {open &&
        mounted &&
        createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/50"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="relative max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-slate-900">{title}</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                닫기 ✕
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {hasAnchors
                ? "담아둔 곳은 그대로 두고, 그 근처에서 빈 시간대만 채워드려요."
                : "1일차는 선택한 시군에서, 다음 날은 숙소 근처에서 이어가요."}{" "}
              {plan.from
                ? `${formatKoreanDate(plan.from)} 출발 기준.`
                : "출발일 미설정 — 오늘 출발 기준."}
            </p>

            {/* 상속된 여행 조건 (편집은 검색 필터에서) */}
            <p className="mt-1 text-xs font-semibold text-slate-500">
              ⚙️ 여행 조건: {courseConditionParts(profile, transport).join(" · ")}{" "}
              <span className="font-normal text-slate-400">
                (검색 필터에서 변경)
              </span>
            </p>

            {/* 테마 — 당일 코스 모달과 동일 칩 스타일 */}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(Object.keys(COURSE_THEME_META) as CourseTheme[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={theme === t}
                  onClick={() => pick(undefined, t)}
                  className={`rounded-xl px-3 py-1.5 text-sm font-semibold transition-colors ${
                    theme === t
                      ? "bg-teal-600 text-white shadow-sm"
                      : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-teal-50 hover:text-teal-700"
                  }`}
                >
                  {COURSE_THEME_META[t].emoji} {COURSE_THEME_META[t].label}
                </button>
              ))}
            </div>

            {/* 지역 — 계획이 비어 있을 때만 필수 (앵커가 있으면 앵커 근처 기준) */}
            {!hasAnchors && (
              <CourseSigunguPicker
                selected={sigungu}
                mine={sigunguCodes}
                onSelect={(code) => pick(code)}
              />
            )}

            {/* 결과 */}
            <div className="mt-4">
              {!hasAnchors && sigungu === undefined ? (
                <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  시작 지역을 선택해 주세요 — 1일차는 그 시군에서, 다음 날은
                  숙소 근처에서 이어가요.
                </p>
              ) : isPending ? (
                <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  일정을 만드는 중…
                </p>
              ) : failed ? (
                <p className="rounded-xl bg-amber-50 px-4 py-6 text-center text-sm font-semibold text-amber-800">
                  일정을 만들지 못했어요 — 잠시 후 다시 시도해 주세요.
                </p>
              ) : result && result.fills.length === 0 ? (
                <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  이 조건으로 채울 빈 시간대를 찾지 못했어요 — 다른 테마를
                  선택하거나, 이미 모든 시간대가 채워져 있는지 확인해 보세요.
                </p>
              ) : result ? (
                <>
                  {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                    const rows = rowsOfDay(d);
                    if (rows.length === 0) return null;
                    return (
                      <section key={d} className="mt-3 first:mt-0">
                        <h3 className="text-sm font-bold text-slate-800">
                          {d}일차{" "}
                          <span className="font-semibold text-slate-400">
                            · {formatKoreanDate(result.dates[d - 1])}
                          </span>
                        </h3>
                        <ul className="mt-1.5 space-y-1">
                          {rows.map((row) =>
                            row.type === "anchor" ? (
                              <li
                                key={`a${row.item.contentId}`}
                                className="flex items-center gap-2 rounded-lg bg-slate-100 px-2.5 py-1.5 text-sm ring-1 ring-slate-200"
                              >
                                <span aria-hidden="true">
                                  {SLOT_META[row.slot].emoji}
                                </span>
                                <span className="min-w-0 flex-1 truncate font-semibold text-slate-500">
                                  {row.item.title}
                                </span>
                                <span className="shrink-0 text-[11px] font-semibold text-slate-400">
                                  담아둔 곳
                                </span>
                              </li>
                            ) : (
                              <li
                                key={`f${row.fill.place.contentId}`}
                                className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ring-1 ${
                                  row.slot === "lodging"
                                    ? "bg-sky-50 ring-sky-100"
                                    : "bg-teal-50/60 ring-teal-100"
                                }`}
                              >
                                <span aria-hidden="true">
                                  {SLOT_META[row.slot].emoji}
                                </span>
                                <span className="min-w-0 flex-1 truncate font-semibold text-slate-700">
                                  {row.fill.place.title}
                                </span>
                                {row.fill.distanceKm > 0 && (
                                  <span className="shrink-0 text-xs text-slate-400">
                                    약 {roadKm(row.fill.distanceKm)}km
                                  </span>
                                )}
                                <span
                                  className={`shrink-0 text-xs font-bold tabular-nums ${GRADE_TEXT[row.fill.place.grade]}`}
                                >
                                  {row.fill.place.score}
                                </span>
                              </li>
                            ),
                          )}
                        </ul>
                      </section>
                    );
                  })}
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                    숙소는 TourAPI 숙박 데이터 기반 참고 정보예요 — 예약·요금은
                    별도로 확인하세요.
                  </p>
                  <button
                    type="button"
                    onClick={applyToPlan}
                    disabled={result.fills.length === 0}
                    className={`mt-3 w-full rounded-xl px-3 py-2.5 text-sm font-bold text-white transition-colors ${
                      saveFailed
                        ? "bg-red-500"
                        : "bg-teal-600 hover:bg-teal-700"
                    }`}
                  >
                    {saveFailed
                      ? "저장 못 했어요"
                      : `빈 시간에 채우기 (${result.fills.length}곳)`}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
