import Link from "next/link";
import type { HalfDayCourse, CourseStop } from "@/lib/course/half-day";
import type { PlaceEnvType } from "@/lib/tour/types";
import { CONTENT_TYPE_LABEL, ENV_TYPE_LABEL } from "@/lib/tour/types";
import type { Profile } from "@/lib/safety/types";
import SafetyScoreBadge from "@/components/SafetyScoreBadge";
import { buildQuery, profileParam } from "@/components/search-params";
import { roadKm } from "@/lib/reco/distance";

const SLOT_META: Record<CourseStop["slot"], { emoji: string; label: string }> =
  {
    morning: { emoji: "🌅", label: "오전" },
    lunch: { emoji: "🍽️", label: "점심" },
    afternoon: { emoji: "☀️", label: "오후" },
  };

/** imageUrl 없는 스톱의 썸네일 플레이스홀더 — 환경 유형별 이모지·그라데이션 */
const ENV_PLACEHOLDER: Record<PlaceEnvType, { emoji: string; bg: string }> = {
  indoor: { emoji: "🏛️", bg: "from-violet-100 to-indigo-200" },
  outdoor_water: { emoji: "🏞️", bg: "from-teal-100 to-cyan-200" },
  outdoor_mountain: { emoji: "⛰️", bg: "from-emerald-100 to-green-200" },
  outdoor_coast: { emoji: "🌊", bg: "from-sky-100 to-blue-200" },
  outdoor_general: { emoji: "🌳", bg: "from-lime-100 to-emerald-200" },
};

interface Props {
  course: HalfDayCourse;
  profile: Profile;
}

export default function CourseTimeline({ course, profile }: Props) {
  const query = buildQuery({ profile: profileParam(profile) });

  return (
    <div className="mt-3">
      <ol className="space-y-0">
        {course.stops.map((stop) => {
          const { place } = stop;
          const meta = SLOT_META[stop.slot];
          const ph = ENV_PLACEHOLDER[place.envType];
          return (
            <li key={place.contentId}>
              {stop.legKm !== undefined && (
                <p className="my-2 ml-5 flex items-center gap-2 text-xs font-semibold text-slate-400">
                  <span aria-hidden="true">↓</span> 약{" "}
                  {roadKm(stop.legKm).toFixed(1)}km 이동
                </p>
              )}
              <div className="flex items-start gap-3">
                <div className="flex w-12 shrink-0 flex-col items-center pt-2">
                  <span className="text-xl" aria-hidden="true">
                    {meta.emoji}
                  </span>
                  <span className="text-xs font-bold text-slate-500">
                    {meta.label}
                  </span>
                </div>
                <Link
                  href={`/places/${place.contentId}${query}`}
                  className="group flex min-w-0 flex-1 items-center gap-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200 transition-shadow hover:shadow-lg hover:ring-teal-300"
                >
                  <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl">
                    {place.imageUrl ? (
                      // TourAPI 외부 이미지 — next/image remotePatterns 설정 없이 표시
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={place.imageUrl}
                        alt={place.title}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div
                        className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${ph.bg}`}
                      >
                        <span className="text-2xl" aria-hidden="true">
                          {ph.emoji}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="truncate text-sm font-bold text-slate-900 group-hover:text-teal-700">
                        {place.title}
                      </h3>
                      <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700 ring-1 ring-teal-200">
                        {CONTENT_TYPE_LABEL[place.contentTypeId]}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200">
                        {ENV_TYPE_LABEL[place.envType]}
                      </span>
                    </div>
                    <div className="mt-1.5">
                      <SafetyScoreBadge
                        score={place.safety.score}
                        grade={place.safety.grade}
                        size="sm"
                      />
                    </div>
                  </div>
                </Link>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-right text-sm font-semibold text-slate-600">
        총 이동 약 {roadKm(course.totalKm).toFixed(1)}km (도로 추정)
      </p>
    </div>
  );
}
