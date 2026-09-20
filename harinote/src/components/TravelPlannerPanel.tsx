"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import CourseRouteMap from "@/components/CourseRouteMap";
import CourseRecommendModal from "@/components/CourseRecommendModal";
import MultiDayCourseModal from "@/components/MultiDayCourseModal";
import { useTravelPlan } from "@/hooks/useTravelPlan";
import { useSavedPlans } from "@/hooks/useSavedPlans";
import {
  duplicateNameExists,
  evictedBySaving,
  MAX_SAVED_PLANS,
  updateTargetFor,
} from "@/lib/saved-plans";
import {
  dateOfDay,
  defaultSlotFor,
  itemsBySlot,
  MEMO_MAX_LEN,
  PLAN_DRAG_TYPE,
  PLAN_SLOTS,
  SLOT_META,
  slotOrderedItems,
  swapItem,
  totalDistanceKm,
  type PlanDragPayload,
  type PlanSlot,
  type TravelPlan,
} from "@/lib/travel-plan";
import { haversineKm, roadKm } from "@/lib/reco/distance";
import { formatKoreanDate, todayISOSeoul } from "@/lib/date";
import { diagnosePlan } from "@/lib/plan/diagnose-action";
import { MAX_STOPS } from "@/lib/plan/diagnose";
import { encodePlanQuery } from "@/lib/plan/report-params";
import {
  planSignature,
  STOP_MODE_LABEL,
  type PlanDiagnosisDto,
  type StopAlternativeDto,
} from "@/lib/plan/diagnose";
import type { Profile } from "@/lib/safety/types";
import type { Transport } from "@/lib/prefs";

/** 자동 재진단 디바운스 — 드래그로 스톱을 연달아 옮기는 동안의 중간 상태를 건너뛴다 */
const DIAGNOSE_DEBOUNCE_MS = 800;

const NIGHTS_OPTIONS = [
  { nights: 0, label: "당일치기" },
  { nights: 1, label: "1박 2일" },
  { nights: 2, label: "2박 3일" },
  { nights: 3, label: "3박 4일" },
];

/**
 * 내 여행 계획 패널 — 카드 드롭으로 담고, 일차별 탭으로 나눠 순서 정렬,
 * 일차마다 직선 루트+총거리. N박이면 1일차/2일차 탭. localStorage 영속.
 */
interface Props {
  compact?: boolean;
  /** 목록의 선택 날짜(?date=) — 코스 추천도 같은 날짜 점수로 (한 화면 두 점수 방지) */
  courseDate?: string;
  /** 안전 진단에 쓰는 동행 프로필·이동수단 — 목록 화면의 현재 조건과 동일하게 */
  profile?: Profile;
  transport?: Transport;
  /** 검색 필터의 시군 복수선택 — 코스 추천 모달의 지역 초기값·그룹 표시용 */
  sigunguCodes?: number[];
}

export default function TravelPlannerPanel({
  compact = false,
  courseDate,
  profile = "default",
  transport = "transit",
  sigunguCodes = [],
}: Props) {
  const { plan, hydrated, add, has, remove, move, moveToDay, moveToSlot, setMemo, replace, setActiveDay, setTrip, clear, count, days, activeDay, byDay } =
    useTravelPlan();
  // 드래그 중 다른 탭/인스턴스가 계획을 바꿔도 안전하도록 인덱스가 아닌
  // contentId를 기억하고, 이동할 인덱스는 드롭 시점의 최신 계획에서 계산한다
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // 드래그 중 커서가 올라가 있는 슬롯 — "여기에 들어간다"를 슬롯 단위로 보여준다
  const [dragOverSlot, setDragOverSlot] = useState<PlanSlot | null>(null);

  // 계획 항목을 패널 밖에 놓으면 빼기 — 내부 드래그 중에만 문서 전체를
  // 드롭 대상으로 만들고, 패널 안에서의 드롭은 기존 핸들러(이동)에 맡긴다.
  // Esc 취소는 drop 이벤트가 없어 안전하게 무시된다.
  const asideRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (dragId === null) return;
    const onDocOver = (e: DragEvent) => e.preventDefault();
    const onDocDrop = (e: DragEvent) => {
      e.preventDefault();
      if (!asideRef.current?.contains(e.target as Node)) remove(dragId);
      // 드래그 상태를 여기서 반드시 끝낸다. 항목이 빠지면 그 <li>가 언마운트되어
      // onDragEnd가 영영 오지 않고, dragId가 남으면 이 문서 전역 리스너가 계속 붙어
      // 관계없는 드래그(주소창·검색창 텍스트 등)를 preventDefault로 가로채며,
      // 다음 바깥 드롭이 이미 지운 항목의 id로 엉뚱한 항목을 지운다.
      setDragId(null);
      setDragOverSlot(null);
      setDropActive(false);
    };
    document.addEventListener("dragover", onDocOver);
    document.addEventListener("drop", onDocDrop);
    return () => {
      document.removeEventListener("dragover", onDocOver);
      document.removeEventListener("drop", onDocDrop);
    };
  }, [dragId, remove]);

  // 계획 저장 — 인라인 이름 입력 → useSavedPlans에 스냅샷 기록
  const { save, list: savedList } = useSavedPlans();
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  // 계획이 비면 저장 폼 상태도 끝낸다. "비우기" 버튼만 setSaving(false)를 하고 있어서,
  // 항목 ✕·패널 밖 드롭으로 비운 경우엔 saving이 남았다 — 폼은 count>0 조건으로 숨겨질 뿐이라
  // 아무거나 다시 담는 순간 옛 이름을 안은 폼이 스스로 열리고 포커스까지 가져갔다.
  // (렌더 중 조정 — 이펙트로 setState 하는 것보다 권장되는 패턴이고 한 번 더 렌더하고 수렴한다)
  if (saving && count === 0) setSaving(false);
  const [savedFlash, setSavedFlash] = useState<"ok" | "fail" | null>(null);
  // 연속 저장 시 이전 2초 타이머가 새 표시(특히 실패)를 조기에 지우지 않도록 정리
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);
  // 불러와서 수정 중이면 원래 이름을 그대로 제안한다 — 날짜 기반 새 이름을 채우면
  // 사용자가 확정만 해도 이름이 바뀌어 목록에서 같은 계획을 알아볼 수 없다
  const origin = plan.savedId
    ? savedList.find((p) => p.id === plan.savedId)
    : undefined;
  const defaultName =
    origin?.name ??
    (plan.from ? `${formatKoreanDate(plan.from)} 여행` : "내 여행 계획");
  // 지금 입력된 이름으로 저장하면 갱신인지 새 계획인지 — 입력 중에도 실시간으로 갈린다
  const pendingName = saveName.trim() || defaultName;
  const updateTarget = updateTargetFor(savedList, plan, pendingName);
  const duplicateName = duplicateNameExists(savedList, plan, pendingName);
  // 지금 저장하면 밀려날 계획 (보관함이 가득 찬 새 계획일 때만)
  const evicted = evictedBySaving(savedList, plan, pendingName);
  const confirmSave = () => {
    if (plan.items.length === 0) return; // 비운 직후 잔류 폼에서 빈 계획 저장 방지
    // 저장 실패(쿼터·차단)를 성공으로 표시하지 않는다 — 무통보 데이터 손실 방지
    const savedId = save(saveName.trim() || defaultName, plan);
    // 새로 저장한 계획에도 id를 새겨, 이어서 고치고 다시 저장하면 갱신이 되게 한다
    if (savedId && plan.savedId !== savedId) replace({ ...plan, savedId });
    setSaving(false);
    setSavedFlash(savedId ? "ok" : "fail");
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSavedFlash(null), 2000);
  };

  // 계획 안전 진단 — 스톱별 일차 날짜 재채점 + 주의 스톱 교체 후보.
  // 사용자가 눌러야 도는 구조였는데, 그러면 안 누른 사람에겐 "담을 당시 점수"(다른
  // 날짜 기준)가 남아 틀린 숫자가 기본값이 된다. 리포트 화면은 이미 진입 즉시 같은
  // 계산을 돌린다 — 두 화면이 같은 값을 보이도록 여기서도 자동으로 돈다.
  const [diag, setDiag] = useState<PlanDiagnosisDto | null>(null);
  const [diagSig, setDiagSig] = useState("");
  const [diagLoading, setDiagLoading] = useState(false);
  // 실패한 계획 서명 — 자동 재시도가 같은 실패를 무한 반복하지 않게 기억한다
  const [failedSig, setFailedSig] = useState<string | null>(null);
  // 서버가 거절하는 크기는 미리 안다 — "잠시 후 다시 시도"는 절대 성공하지 않는 안내가 된다
  const tooManyStops = count > MAX_STOPS;
  // 스톱 구성·출발일·조건이 바뀌면 기존 진단은 낡은 것 (순서 변경은 무관)
  const currentSig =
    hydrated && count > 0 ? planSignature(plan, profile, transport) : "";
  const diagStale = diag !== null && currentSig !== diagSig;
  const diagError = failedSig !== null && failedSig === currentSig;

  async function runDiagnosis(target?: TravelPlan) {
    const p = target ?? plan;
    if (p.items.length === 0 || diagLoading) return;
    if (p.items.length > MAX_STOPS) return; // 안내는 따로 띄우고, 코스 담기 경로도 막는다
    const sig = planSignature(p, profile, transport);
    setDiagLoading(true);
    setFailedSig(null);
    try {
      const result = await diagnosePlan({
        items: p.items.map((it) => ({ contentId: it.contentId, day: it.day ?? 1 })),
        from: p.from,
        profile,
        transport,
      });
      setDiag(result);
      setDiagSig(sig);
    } catch {
      setFailedSig(sig);
    } finally {
      setDiagLoading(false);
    }
  }

  // 최신 계획을 담은 진단 함수 — 아래 자동 실행 이펙트가 매 렌더 재구독하지 않게 ref로 넘긴다
  const runRef = useRef(runDiagnosis);
  useEffect(() => {
    runRef.current = runDiagnosis;
  });

  // 계획·조건이 바뀌면 자동 재진단. 드래그로 스톱을 옮기는 중간 상태마다 서버를
  // 때리지 않도록 디바운스하고, 이미 실패한 서명은 사용자가 "다시 시도"를 누를 때만.
  useEffect(() => {
    if (!hydrated || currentSig === "" || tooManyStops) return;
    if (currentSig === diagSig) return; // 이미 최신
    if (currentSig === failedSig) return; // 실패 직후 — 자동 반복 금지
    if (diagLoading) return; // 진행 중인 요청이 끝나면 이 이펙트가 다시 판단한다
    const t = setTimeout(() => void runRef.current(), DIAGNOSE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [hydrated, currentSig, diagSig, failedSig, diagLoading, tooManyStops]);
  const diagByStop = new Map(
    !diagStale && diag ? diag.stops.map((s) => [s.contentId, s]) : [],
  );

  // 교체(⇄): 같은 자리에서 바꾸고 새 계획으로 즉시 재진단
  function swapWithAlternative(oldContentId: number, alt: StopAlternativeDto) {
    const next = swapItem(plan, oldContentId, {
      contentId: alt.contentId,
      title: alt.title,
      lat: alt.lat,
      lng: alt.lng,
      score: alt.score,
    });
    if (next === plan) return;
    replace(next);
    void runDiagnosis(next);
  }

  // 카드에서 온 드롭 페이로드 파싱 (없으면 null = 내부 순서변경)
  function parseCardDrop(e: React.DragEvent): PlanDragPayload | null {
    const raw = e.dataTransfer.getData(PLAN_DRAG_TYPE);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PlanDragPayload;
    } catch {
      return null;
    }
  }

  // 카드 페이로드를 지정 일차·슬롯에 담기 — 슬롯 미지정이면 카테고리 기반 기본 슬롯.
  // 이미 담긴 카드면 add가 no-op이라 아무 일도 안 일어남 → "이동" 처리
  function addPayload(payload: PlanDragPayload, day: number, slot?: PlanSlot) {
    const { contentTypeId, ...item } = payload;
    if (has(item.contentId)) {
      moveToDay(item.contentId, day);
      if (slot) moveToSlot(item.contentId, slot);
      return;
    }
    add(
      { ...item, slot: slot ?? defaultSlotFor(contentTypeId, byDay[day - 1] ?? []) },
      day,
    );
  }

  // 드롭존(빈 공간·컨테이너)에 카드가 떨어지면 활성 일차로 추가
  function onZoneDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropActive(false);
    setDragOverSlot(null);
    const payload = parseCardDrop(e);
    if (!payload) return;
    addPayload(payload, activeDay);
  }

  // 슬롯 섹션 드롭 — 카드는 그 슬롯으로 담고, 내부 항목 드래그는 슬롯 이동
  function onSlotDrop(e: React.DragEvent, slot: PlanSlot) {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);
    const payload = parseCardDrop(e);
    if (payload) {
      addPayload(payload, activeDay, slot);
      return;
    }
    if (dragId !== null) {
      moveToSlot(dragId, slot);
      setDragId(null);
    }
  }

  const dayLabel = (d: number) => {
    const iso = dateOfDay(plan, d);
    return iso ? formatKoreanDate(iso) : `${d}일차`;
  };

  // 메모 편집 중인 항목 (한 번에 하나)
  const [memoEditId, setMemoEditId] = useState<number | null>(null);

  const dayItems = hydrated ? (byDay[activeDay - 1] ?? []) : [];
  const slotGroups = itemsBySlot(dayItems);
  // 시간 슬롯 순 체인 — 번호·스톱 간 거리·지도·총거리 공용
  const orderedDayItems = slotOrderedItems(dayItems);
  const isLastDay = activeDay === days;
  // 풀코스 추천은 채울 여지가 있을 때만 — 당일치기 빈 계획엔 "빈 시간만 채우기"가 성립하지 않는다
  const showFullCourse = hydrated && (days > 1 || count > 0);

  return (
    <aside
      ref={asideRef}
      aria-label="내 여행 계획"
      className={`flex flex-col rounded-2xl bg-white ring-1 ring-slate-200 ${compact ? "" : ""}`}
    >
      {/* 내부 항목 드래그 중 안내 — 밖에 놓으면 삭제 */}
      {dragId !== null && (
        <p className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900/80 px-4 py-2 text-xs font-semibold text-white shadow-lg">
          🗑 패널 밖에 놓으면 계획에서 빠져요
        </p>
      )}
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-base font-bold text-slate-900">
          🗺 내 여행 계획
          {hydrated && count > 0 && (
            <span className="ml-1.5 text-sm font-semibold text-teal-600">{count}</span>
          )}
        </h2>
        {/* 셋의 시각 무게를 역할에 맞춘다 — 리포트는 계획을 들고 나가는 출구(주 행동),
            저장은 보조, 비우기는 되돌릴 수 없으니 조용하게. 이전엔 셋 다 slate-400이라
            흰 배경 대비 약 3:1로 작은 글씨 기준 WCAG AA(4.5:1)에 못 미쳤다 */}
        {hydrated && count > 0 && (
          <div className="flex items-center gap-2">
            <Link
              href={`/plans/report?${encodePlanQuery(plan)}${
                profile !== "default" ? `&profile=${profile}` : ""
              }${transport === "car" ? "&tr=car" : ""}`}
              className="rounded-lg px-2 py-1 text-xs font-bold text-teal-700 ring-1 ring-teal-600/40 transition-colors hover:bg-teal-50"
            >
              리포트
            </Link>
            <button
              type="button"
              onClick={() => {
                setSaveName(defaultName);
                setSaving((v) => !v);
              }}
              className={`px-1 text-xs font-semibold transition-colors ${
                savedFlash === "ok"
                  ? "text-teal-600"
                  : savedFlash === "fail"
                    ? "text-red-500"
                    : "text-slate-600 hover:text-teal-600"
              }`}
            >
              {savedFlash === "ok"
                ? "✓ 저장했어요"
                : savedFlash === "fail"
                  ? "저장 못 했어요"
                  : "저장"}
            </button>
            <button
              type="button"
              onClick={() => {
                setSaving(false);
                clear();
              }}
              className="px-1 text-xs font-semibold text-slate-500 transition-colors hover:text-red-500"
            >
              비우기
            </button>
          </div>
        )}
      </div>

      {/* 저장 이름 입력 (저장 버튼 토글) — 계획이 비면 함께 사라진다 */}
      {saving && hydrated && count > 0 && (
        <form
          className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            confirmSave();
          }}
        >
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            aria-label="계획 이름"
            maxLength={30}
            autoFocus
            className="min-w-0 flex-1 rounded-lg bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-teal-600 px-2.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-teal-700"
          >
            저장
          </button>
          {/* 갱신인지 새 계획인지 저장 "전에" 보여준다 — 이름 한 글자가 결과를 가른다 */}
          <p className="w-full text-xs font-semibold text-slate-500">
            {updateTarget
              ? `저장한 "${updateTarget.name}"을(를) 갱신합니다 — 이름을 바꾸면 새 계획으로 저장돼요`
              : origin
                ? `새 계획으로 저장합니다 — 저장한 "${origin.name}"은(는) 그대로 남아요`
                : "새 계획으로 저장합니다"}
          </p>
          {/* 같은 이름이 이미 있는데 갱신은 아닌 경우 — 합치지 않고 둘 다 남기되 미리 알린다.
              이름만 보고 덮어쓰면 방금 고친 "조용히 사라지는 계획"이 그대로 돌아온다 */}
          {duplicateName && (
            <p className="w-full text-xs font-semibold text-amber-600">
              같은 이름의 계획이 이미 있어요 — 합쳐지지 않고 둘 다 남습니다.
              구분하려면 이름을 바꿔주세요
            </p>
          )}
          {/* 보관함이 가득 찼을 때 무엇이 사라지는지 저장 "전에" 알린다 —
              사용자 데이터가 조용히 없어지지 않게 하는 것이 상한값보다 중요하다 */}
          {evicted && (
            <p className="w-full text-xs font-semibold text-amber-600">
              보관함이 {MAX_SAVED_PLANS}개로 가득 찼어요 — 저장하면 가장 오래된
              &ldquo;{evicted.name}&rdquo;이(가) 밀려납니다. 남기려면 저장한 계획
              탭에서 하나를 먼저 지워주세요
            </p>
          )}
        </form>
      )}

      {/* 코스 추천 두 갈래 — 여행 길이 축(전체 vs 하루). 이 화면의 목표가 "여행 만들기"라
          풀코스가 주 행동(색)이고 위에 선다. 다만 풀코스는 당일치기 + 빈 계획일 땐 뜨지
          않으므로, 그때는 하루 코스가 유일한 주 행동이 되도록 색을 넘겨받는다 */}
      <div className="space-y-2 border-b border-slate-100 px-4 py-2.5">
        {/* 담긴 곳이 있으면 빈 시간대만, 비어 있는 N박이면 전체 일정 (이름은 고정) */}
        {showFullCourse && (
          <MultiDayCourseModal
            profile={profile}
            transport={transport}
            sigunguCodes={sigunguCodes}
          />
        )}
        <CourseRecommendModal
          date={courseDate}
          profile={profile}
          transport={transport}
          sigunguCodes={sigunguCodes}
          variant={showFullCourse ? "secondary" : "primary"}
        />
      </div>

      {/* 여행 일수·출발일 설정 — localStorage 계획에만 반영 (일차 탭·날짜 라벨) */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5">
        <select
          value={hydrated ? (plan.nights ?? 0) : 0}
          onChange={(e) => setTrip(Number(e.target.value), plan.from)}
          aria-label="여행 일수"
          className="rounded-lg bg-white px-2 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          {NIGHTS_OPTIONS.map((o) => (
            <option key={o.nights} value={o.nights}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={hydrated ? (plan.from ?? "") : ""}
          min={todayISOSeoul()}
          onChange={(e) =>
            setTrip(plan.nights ?? 0, e.target.value || undefined)
          }
          aria-label="여행 출발일"
          className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
      </div>

      {/* 계획 안전 진단 — 각 스톱을 해당 일차 날짜 기준으로 자동 재채점 (버튼 없음) */}
      {hydrated && count > 0 && (
        <div className="border-b border-slate-100 px-4 py-2.5">
          {tooManyStops ? (
            <p className="text-xs font-semibold text-amber-600">
              스톱이 {MAX_STOPS}곳을 넘어 진단할 수 없어요 (현재 {count}곳). 리포트도 앞{" "}
              {MAX_STOPS}곳만 나옵니다 — 일부를 빼주세요
            </p>
          ) : diagError ? (
            <p className="flex items-center gap-2 text-xs font-semibold text-red-500">
              안전 진단에 실패했어요
              <button
                type="button"
                onClick={() => void runDiagnosis()}
                className="rounded-lg px-2 py-0.5 font-bold text-teal-700 ring-1 ring-teal-600/40 transition-colors hover:bg-teal-50"
              >
                다시 시도
              </button>
            </p>
          ) : diagLoading || diagStale || !diag ? (
            <p className="text-xs font-semibold text-slate-400">
              🩺 계획 안전 진단 중…
            </p>
          ) : (
            <p
              className={`text-xs font-semibold ${
                diag.riskyCount > 0 ? "text-amber-700" : "text-teal-700"
              }`}
            >
              {diag.riskyCount > 0
                ? `⚠️ 주의 스톱 ${diag.riskyCount}곳 — 교체 후보를 확인해 보세요`
                : "✓ 전 스톱 방문 주의 요인 낮음"}
              {/* assumedToday는 "미설정"과 "지난 날짜"를 한 값으로 뭉친다 — 출발일이
                  설정·표시돼 있는데 "미설정"이라 말하면 바로 위 날짜 라벨과 모순된다 */}
              {diag.assumedToday && (
                <span className="font-normal text-slate-400">
                  {" "}
                  ·{" "}
                  {plan.from
                    ? "출발일이 지나 오늘 기준으로 계산"
                    : "출발일 미설정, 오늘 출발 기준"}
                </span>
              )}
            </p>
          )}
        </div>
      )}

      {/* 일차 탭 (N박일 때만) */}
      {days > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-slate-100 px-3 py-2">
          {Array.from({ length: days }, (_, i) => i + 1).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setActiveDay(d)}
              onDragOver={(e) => {
                // 목록 카드(PLAN_DRAG_TYPE)뿐 아니라 패널 내부 항목 드래그(dragId)도 받는다.
                // 내부 드래그는 text/plain만 싣기 때문에 타입 검사만 하면 여기서 걸러지는데,
                // 정작 문서 전역 dragover가 preventDefault를 걸어 커서는 "놓을 수 있음"으로
                // 바뀌었다 — 놓을 수 있다고 해놓고 아무 일도 안 하던 원인.
                if (
                  dragId !== null ||
                  e.dataTransfer.types.includes(PLAN_DRAG_TYPE)
                ) {
                  e.preventDefault();
                }
              }}
              onDrop={(e) => {
                // 다른 일차 탭 위로 카드를 떨어뜨리면 그 일차로 담김 (이미 담긴 카드는 이동)
                const payload = parseCardDrop(e);
                if (payload) {
                  e.preventDefault();
                  addPayload(payload, d);
                  setActiveDay(d);
                  return;
                }
                // 패널 내부 항목을 끌어온 경우 — 그 일차로 옮긴다
                if (dragId !== null) {
                  e.preventDefault();
                  e.stopPropagation(); // 문서 드롭 핸들러가 "패널 밖 = 빼기"로 오인하지 않게
                  moveToDay(dragId, d);
                  setActiveDay(d);
                  setDragId(null);
                  setDragOverSlot(null);
                }
              }}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold transition-colors ${
                activeDay === d
                  ? "bg-teal-600 text-white"
                  : "bg-slate-100 text-slate-500 hover:bg-slate-200"
              }`}
            >
              {d}일차
              {byDay[d - 1]?.length ? ` (${byDay[d - 1].length})` : ""}
            </button>
          ))}
        </div>
      )}

      {/* 활성 일차 날짜 */}
      {hydrated && plan.from && (
        <p className="px-4 pt-2 text-xs font-semibold text-sky-700">
          {dayLabel(activeDay)} 기준
        </p>
      )}

      {/* 담긴 관광지 — 드롭존 + 순서 드래그 */}
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(PLAN_DRAG_TYPE)) {
            e.preventDefault();
            setDropActive(true);
          }
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={onZoneDrop}
        className={`mx-3 my-2 min-h-[80px] rounded-xl p-1 transition-colors ${
          // 특정 슬롯 위에서는 슬롯 하이라이트만 — 전체 배경까지 켜면 "어디로 들어가는지"가 흐려진다
          dropActive && dragOverSlot === null ? "bg-teal-50 ring-2 ring-teal-300" : ""
        }`}
      >
        {!hydrated || dayItems.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-slate-400">
            관광지 카드를 여기로 드래그하거나
            <br />
            <span className="font-semibold text-slate-500">+ 계획</span> 버튼으로 담아보세요
          </p>
        ) : (
          <div className="space-y-2.5">
            {PLAN_SLOTS.map((slot) => {
              // 마지막 일차의 숙소 슬롯은 숨김 (기간 축소로 밀려온 항목이 있으면 유실 방지 위해 표시)
              if (slot === "lodging" && isLastDay && slotGroups.lodging.length === 0) {
                return null;
              }
              const group = slotGroups[slot];
              return (
                <section
                  key={slot}
                  aria-label={SLOT_META[slot].label}
                  onDragOver={(e) => {
                    if (
                      e.dataTransfer.types.includes(PLAN_DRAG_TYPE) ||
                      dragId !== null
                    ) {
                      e.preventDefault();
                      if (dragOverSlot !== slot) setDragOverSlot(slot);
                    }
                  }}
                  onDragLeave={(e) => {
                    // 자식 요소로 이동할 때 발생하는 leave는 무시 — 진짜로 섹션을 벗어날 때만 해제
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setDragOverSlot((v) => (v === slot ? null : v));
                    }
                  }}
                  onDrop={(e) => {
                    setDragOverSlot(null);
                    onSlotDrop(e, slot);
                  }}
                  className={`rounded-xl p-1 transition-colors ${
                    dragOverSlot === slot ? "bg-teal-100/70 ring-2 ring-teal-400" : ""
                  }`}
                >
                  <p
                    className={`mb-1 px-1 text-[11px] font-bold ${
                      dragOverSlot === slot ? "text-teal-700" : "text-slate-400"
                    }`}
                  >
                    <span aria-hidden="true">{SLOT_META[slot].emoji}</span>{" "}
                    {SLOT_META[slot].label}
                    {dragOverSlot === slot && " — 여기에 놓기"}
                  </p>
                  {group.length === 0 ? (
                    <p
                      className={`rounded-lg border border-dashed px-2.5 py-2 text-center text-[11px] transition-colors ${
                        dragOverSlot === slot
                          ? "border-teal-400 bg-white/60 font-semibold text-teal-700"
                          : "border-slate-200 text-slate-300"
                      }`}
                    >
                      {dragOverSlot === slot
                        ? "여기에 놓기"
                        : slot === "lodging"
                          ? "풀코스 추천으로 숙소도 함께 받아보세요"
                          : "여기로 드래그해서 담기"}
                    </p>
                  ) : (
                    <ol className="space-y-1.5">
                      {group.map((it) => {
              const globalIdx = plan.items.indexOf(it);
              const orderIdx = orderedDayItems.indexOf(it);
              const prev = orderIdx > 0 ? orderedDayItems[orderIdx - 1] : null;
              const legKm = prev
                ? Math.round(haversineKm(prev.lat, prev.lng, it.lat, it.lng) * 10) / 10
                : null;
              const stop = diagByStop.get(it.contentId);
              const risky = stop?.grade !== undefined && stop.grade !== null && stop.grade !== "low";
              return (
                <li
                  key={it.contentId}
                  draggable
                  onDragStart={(e) => {
                    // Firefox는 dragstart에서 데이터가 없으면 드래그를 시작하지 않는다
                    e.dataTransfer.setData("text/plain", it.title);
                    e.dataTransfer.effectAllowed = "move";
                    setDragId(it.contentId);
                  }}
                  // 취소(Esc)·바깥 드롭 포함 어떤 종료에서도 잔류 dragId 정리 —
                  // 남아 있으면 이후 무관한 드래그가 onDrop에서 순서를 뒤섞는다
                  onDragEnd={() => {
                    setDragId(null);
                    setDragOverSlot(null);
                  }}
                  onDragOver={(e) => {
                    // 내부 순서변경일 때만 이 항목이 드롭을 받는다
                    if (dragId !== null) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    const item = parseCardDrop(e);
                    if (item) {
                      // 외부 카드는 슬롯 섹션이 처리하도록 버블링 (가로채지 않음)
                      return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    // 드롭 시점의 최신 계획에서 인덱스 계산 — 항목이 사라졌으면 -1 → reorder no-op
                    const fromIdx =
                      dragId !== null
                        ? plan.items.findIndex((p) => p.contentId === dragId)
                        : -1;
                    if (fromIdx >= 0 && fromIdx !== globalIdx) {
                      move(fromIdx, globalIdx);
                      // 다른 슬롯의 항목 위에 떨어뜨리면 그 슬롯으로 합류
                      if (dragId !== null && it.slot && it.slot !== plan.items[fromIdx].slot) {
                        moveToSlot(dragId, it.slot);
                      }
                    }
                    // 슬롯을 넘어 옮기면 이 <li>가 다른 슬롯 섹션으로 재마운트되어
                    // onDragEnd가 오지 않는다 — 하이라이트를 여기서 직접 끈다
                    setDragId(null);
                    setDragOverSlot(null);
                  }}
                  className={`rounded-lg bg-slate-50 px-2.5 py-2 ring-1 ${
                    risky ? "ring-amber-300" : "ring-slate-100"
                  }`}
                >
                  {legKm !== null && (
                    <p className="mb-1 pl-7 text-[10px] font-semibold text-slate-400">
                      ↓ 약 {roadKm(legKm)}km
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-teal-600 text-[11px] font-bold text-white">
                    {orderIdx + 1}
                  </span>
                  {/* 숙박도 상세가 있다 — places/[contentId]가 관광지 조회 실패 시 숙박으로 폴백 */}
                  <Link
                    href={`/places/${it.contentId}`}
                    className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700 hover:text-teal-700"
                  >
                    {it.title}
                  </Link>
                  {stop && stop.score !== null ? (
                    // 진단 점수 — 해당 일차 날짜 기준 (담을 당시 점수를 대체)
                    <span
                      title={`${STOP_MODE_LABEL[stop.mode]}${
                        stop.topFactors.length > 0
                          ? ` · ${stop.topFactors.map((f) => `${f.label} −${f.points}점`).join(" · ")}`
                          : ""
                      }`}
                      className={`shrink-0 text-xs font-bold tabular-nums ${
                        stop.grade === "low"
                          ? "text-teal-600"
                          : stop.grade === "moderate"
                            ? "text-amber-600"
                            : "text-red-600"
                      }`}
                    >
                      {risky && "⚠ "}
                      {stop.score}
                    </span>
                  ) : it.score !== undefined ? (
                    <span className="shrink-0 text-xs font-bold tabular-nums text-slate-400">
                      {it.score}
                    </span>
                  ) : null}
                  {/* 다른 시간대로 이동 */}
                  <select
                    value={it.slot ?? "morning"}
                    onChange={(e) => moveToSlot(it.contentId, e.target.value as PlanSlot)}
                    aria-label="시간대 변경"
                    className="shrink-0 rounded bg-white text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200"
                  >
                    {PLAN_SLOTS.map((s) => (
                      <option key={s} value={s}>
                        {SLOT_META[s].label}
                      </option>
                    ))}
                  </select>
                  {/* 다른 일차로 이동 (N박일 때) */}
                  {days > 1 && (
                    <select
                      value={activeDay}
                      onChange={(e) => moveToDay(it.contentId, Number(e.target.value))}
                      aria-label="일차 변경"
                      className="shrink-0 rounded bg-white text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200"
                    >
                      {Array.from({ length: days }, (_, i) => i + 1).map((d) => (
                        <option key={d} value={d}>
                          {d}일차
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setMemoEditId((v) => (v === it.contentId ? null : it.contentId))
                    }
                    aria-label={`${it.title} 메모`}
                    title="메모"
                    className={`shrink-0 text-xs transition-colors ${
                      it.memo ? "text-teal-600" : "text-slate-300 hover:text-teal-600"
                    }`}
                  >
                    📝
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(it.contentId)}
                    aria-label={`${it.title} 빼기`}
                    className="shrink-0 text-slate-300 transition-colors hover:text-red-500"
                  >
                    ✕
                  </button>
                  </div>
                  {/* 스톱 메모 — 편집 중이면 입력, 아니면 표시(클릭 시 편집) */}
                  {memoEditId === it.contentId ? (
                    <input
                      type="text"
                      defaultValue={it.memo ?? ""}
                      maxLength={MEMO_MAX_LEN}
                      autoFocus
                      placeholder="메모 (예: 예약 14시, 우산 챙기기)"
                      aria-label={`${it.title} 메모 입력`}
                      onBlur={(e) => {
                        setMemo(it.contentId, e.target.value);
                        setMemoEditId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") {
                          // 저장 없이 닫기 — blur 커밋이 원래 값으로 no-op 되게 복원
                          e.currentTarget.value = it.memo ?? "";
                          e.currentTarget.blur();
                        }
                      }}
                      className="ml-7 mt-1.5 w-[calc(100%-1.75rem)] rounded-lg bg-white px-2 py-1 text-[11px] text-slate-600 ring-1 ring-teal-300 focus:outline-none"
                    />
                  ) : it.memo ? (
                    <button
                      type="button"
                      onClick={() => setMemoEditId(it.contentId)}
                      className="ml-7 mt-1 block max-w-[calc(100%-1.75rem)] truncate text-left text-[11px] text-slate-500 hover:text-teal-700"
                    >
                      {it.memo}
                    </button>
                  ) : null}
                  {/* 주의 스톱 — 요인 안내 + 같은 자리 교체 후보 */}
                  {stop && risky && (
                    <div className="mt-1.5 space-y-1 pl-7">
                      {stop.topFactors.length > 0 && (
                        <p className="text-[11px] font-semibold text-amber-700">
                          {stop.topFactors
                            .map((f) => `${f.label} −${f.points}점`)
                            .join(" · ")}
                          <span className="font-normal text-slate-400">
                            {" "}
                            · {STOP_MODE_LABEL[stop.mode]}
                          </span>
                        </p>
                      )}
                      {stop.alternatives.map((alt) => (
                        <button
                          key={alt.contentId}
                          type="button"
                          onClick={() => swapWithAlternative(it.contentId, alt)}
                          className="flex w-full items-center gap-1.5 rounded-lg bg-white px-2 py-1.5 text-left text-xs ring-1 ring-slate-200 transition-colors hover:bg-teal-50 hover:ring-teal-300"
                        >
                          <span className="shrink-0 font-bold text-teal-700">⇄</span>
                          <span className="min-w-0 flex-1 truncate font-semibold text-slate-600">
                            {alt.title}
                          </span>
                          <span className="shrink-0 font-bold tabular-nums text-teal-600">
                            {alt.score}
                          </span>
                          <span className="shrink-0 text-slate-400">
                            약 {roadKm(alt.distanceKm)}km
                          </span>
                        </button>
                      ))}
                      {stop.alternatives.length === 0 && (
                        <p className="text-[11px] text-slate-400">
                          근처에 더 나은 대체지가 없어요
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
                      })}
                    </ol>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* 활성 일차 루트 지도 + 총거리 (2곳 이상) — 시간 슬롯 순 체인 */}
      {hydrated && orderedDayItems.length >= 2 && (
        <div className="border-t border-slate-100 p-3">
          <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>{days > 1 ? `${activeDay}일차 ` : ""}이동 경로</span>
            <span className="text-slate-700">
              직선 {totalDistanceKm(orderedDayItems)}km
            </span>
          </div>
          <CourseRouteMap
            stops={orderedDayItems.map((it) => ({ title: it.title, lat: it.lat, lng: it.lng }))}
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
            직선 거리 기준이에요. 실제 소요 시간은 지도 앱에서 확인하세요.
          </p>
        </div>
      )}
    </aside>
  );
}
