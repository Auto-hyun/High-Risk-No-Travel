/**
 * 계획 리포트 "주의할 점" — 감점 요인을 읽는 사람에게 말하듯 풀어 쓴다.
 *
 * 점수를 옮겨 적으면("강수 −8점") 리포트를 받은 사람은 아무것도 알 수 없다.
 * 필요한 건 "며칠에 비 올 확률이 얼마고, 그래서 뭘 하면 되는가"다.
 * 그래서 여기서는 감점(points)을 아예 쓰지 않고 관측·예보값(value)과 날짜만 쓴다.
 *
 * 기상 요인은 날짜가 정하므로 요인당 한 줄로 묶어 날짜를 문장 안에 넣고,
 * 응급의료는 장소가 정하므로 가장 나쁜 곳을 이름으로 지목한다.
 */
import type { Profile, RiskFactorKey } from "@/lib/safety/types";
import type { Place } from "@/lib/tour/types";
import {
  COLD,
  FOREST_FIRE,
  HEAT,
  HEAVY_RAIN,
  LANDSLIDE,
  PM25,
  RAIN_WIND,
  pmGradeLabel,
} from "@/lib/safety/weights";

/** 이 온도 이하의 열쾌적 감점은 더위가 아니라 추위 쪽 (checklist.ts와 같은 기준) */
const THERMAL_COOL_MAX_C = 10;

/** 날짜를 3개까지만 늘어놓는다 — 그 이상은 문장이 날짜 목록이 되어 버린다 */
const MAX_DATES_SHOWN = 3;

export interface CautionStop {
  /** 이 스톱이 평가된 날짜 (YYYY-MM-DD) */
  dateISO: string;
  title: string;
  envType: Place["envType"];
  riskFactors: { key: RiskFactorKey; value: number }[];
}

export interface PlanCaution {
  /** 렌더 key 겸 중복 방지 */
  key: string;
  text: string;
}

/**
 * 요인을 모으는 단위. heat 키는 관광기후지수 열쾌적이라 더위와 추위가 같이 들어오므로
 * 체감온도 값으로 갈라 담는다 (한 줄에 "덥고 춥습니다"가 나오면 안 된다).
 */
type Bucket =
  | Exclude<RiskFactorKey, "heat" | "sun">
  | "heat_hot"
  | "heat_cool";

/** 위험이 큰 것부터 — 종이 위에서 위에 있는 줄이 먼저 읽힌다 */
const ORDER: Bucket[] = [
  "landslide",
  "heavy_rain",
  "forest_fire",
  "heat_hot",
  "cold",
  "heat_cool",
  "wind",
  "rain",
  "pm",
  "medical",
];

/** 값이 나쁜 쪽 — 추위 계열만 낮을수록 나쁘다 */
const LOWER_IS_WORSE: Bucket[] = ["cold", "heat_cool"];

/**
 * 여기 못 미치면 "주의할 점"으로 올리지 않는다.
 *
 * 점수 엔진은 관광 쾌적 감점까지 요인으로 내보낸다 — 바람 2.6m/s, 미세먼지 '보통'도
 * 요인이다. 그걸 그대로 경고 문장으로 옮기면 "바람이 2.6m/s로 강한 편입니다" 같은
 * 거짓말이 되고, 진짜 위험한 줄까지 같이 값싸진다. 준비물(마스크·바람막이)은
 * 엔진 기준 그대로 두되, 경고는 실제로 조심해야 하는 세기부터만 한다.
 */
const WORTH_WARNING: Partial<Record<Bucket, (v: number) => boolean>> = {
  wind: (v) => v >= RAIN_WIND.WIND_CAUTION_MS,
  pm: (v) => v > PM25.MODERATE_MAX, // '나쁨'부터
};

interface Collected {
  /** 가장 나쁜 값 */
  worst: number;
  /** 그 요인이 걸린 날짜 (오름차순, 중복 없음) */
  dates: string[];
  /** 가장 나쁜 값이 나온 스톱 이름 */
  worstTitle: string;
  /** 계곡·바닷가 등 물가 스톱이 섞여 있는지 */
  hasWater: boolean;
}

/** "2026-08-05" → "8월 5일" (요일은 뺀다 — 여러 날을 이어 쓰면 문장이 길어진다) */
function shortDate(dateISO: string): string {
  const [, m, d] = dateISO.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
}

function dateLabel(dates: string[]): string {
  if (dates.length <= MAX_DATES_SHOWN) return dates.map(shortDate).join("·");
  return `${shortDate(dates[0])} 외 ${dates.length - 1}일`;
}

function collect(stops: CautionStop[]): Map<Bucket, Collected> {
  const out = new Map<Bucket, Collected>();
  for (const stop of stops) {
    for (const { key, value } of stop.riskFactors) {
      if (key === "sun") continue; // 흐림은 주의할 일이 아니라 아쉬운 일이다
      let bucket: Bucket;
      if (key === "heat") {
        if (value >= HEAT.RAMP_START_C) bucket = "heat_hot";
        else if (value <= THERMAL_COOL_MAX_C) bucket = "heat_cool";
        else continue;
      } else {
        bucket = key;
      }
      const worthWarning = WORTH_WARNING[bucket];
      if (worthWarning && !worthWarning(value)) continue;

      const found = out.get(bucket);
      if (!found) {
        out.set(bucket, {
          worst: value,
          dates: [stop.dateISO],
          worstTitle: stop.title,
          hasWater: stop.envType === "outdoor_water",
        });
        continue;
      }
      const worse = LOWER_IS_WORSE.includes(bucket)
        ? value < found.worst
        : value > found.worst;
      if (worse) {
        found.worst = value;
        found.worstTitle = stop.title;
      }
      if (!found.dates.includes(stop.dateISO)) found.dates.push(stop.dateISO);
      if (stop.envType === "outdoor_water") found.hasWater = true;
    }
  }
  for (const c of out.values()) c.dates.sort();
  return out;
}

/** 소수점이 붙는 값(체감온도·거리)은 한 자리까지만 */
const round1 = (v: number) => Math.round(v * 10) / 10;

export function buildPlanCautions(
  stops: CautionStop[],
  profile: Profile,
): PlanCaution[] {
  const withKids = profile === "with_kids" || profile === "with_kids_seniors";
  const withSeniors =
    profile === "with_seniors" || profile === "with_kids_seniors";

  const found = collect(stops);
  const out: PlanCaution[] = [];
  const add = (key: string, text: string) => out.push({ key, text });

  for (const bucket of ORDER) {
    const c = found.get(bucket);
    if (!c) continue;
    const when = dateLabel(c.dates);
    const v = round1(c.worst);

    switch (bucket) {
      case "landslide": {
        const label = LANDSLIDE.LEVEL_LABEL[c.worst as 0 | 1 | 2];
        add(
          bucket,
          `${when} 산림청 산사태 ${label}가 발령 중입니다. 비가 온 뒤 산길과 계곡 구간은 돌아가세요.`,
        );
        break;
      }
      case "heavy_rain": {
        const how =
          c.worst >= HEAVY_RAIN.WARN_MM
            ? "호우경보 수준"
            : c.worst >= HEAVY_RAIN.WATCH_MM
              ? "호우주의보 수준"
              : "많은 비";
        add(
          bucket,
          `${when} 비가 ${v}mm까지 내립니다(${how}). 계곡과 하천에 가까이 가지 말고 이동 시간을 넉넉히 잡으세요.`,
        );
        break;
      }
      case "forest_fire": {
        const label = FOREST_FIRE.LEVEL_LABEL[c.worst as 1 | 2 | 3 | 4];
        add(
          bucket,
          `${when} 산불위험이 ${label}입니다. 산 근처에서 불씨를 다루지 말고, 입산 통제 구간을 미리 확인하세요.`,
        );
        break;
      }
      case "heat_hot": {
        const how =
          c.worst >= HEAT.WARNING_C
            ? "폭염경보 수준까지 오릅니다"
            : c.worst >= HEAT.ADVISORY_C
              ? "폭염주의보 수준까지 오릅니다"
              : "올라 덥습니다";
        add(
          bucket,
          `${when} 낮 체감온도가 ${v}℃로 ${how}. 물을 자주 마시고 한낮 야외 일정은 짧게 나눠 잡으세요.` +
            (withKids
              ? " 아이가 얼굴이 붉어지거나 기운 없어 하면 바로 그늘에서 쉬게 하세요."
              : ""),
        );
        break;
      }
      case "cold": {
        const how =
          c.worst <= COLD.WARNING_C
            ? "한파경보 수준"
            : c.worst <= COLD.ADVISORY_C
              ? "한파주의보 수준"
              : "매우 추운 날씨";
        add(
          bucket,
          `${when} 아침 최저기온이 ${v}℃로 ${how}입니다. 야외에 오래 서 있지 말고 실내에서 몸을 녹일 곳을 중간에 넣으세요.` +
            (withKids || withSeniors
              ? " 아이와 어르신은 체온이 빨리 떨어지니 더 짧게 다니세요."
              : ""),
        );
        break;
      }
      case "heat_cool":
        add(
          bucket,
          `${when} 낮 체감온도가 ${v}℃로 쌀쌀합니다. 겉옷을 챙기고 해가 진 뒤 일정은 줄이세요.`,
        );
        break;
      case "wind": {
        const how =
          c.worst >= RAIN_WIND.WIND_ADVISORY_MS ? "강풍주의보 수준" : "강한 편";
        add(
          bucket,
          `${when} 바람이 ${v}m/s로 ${how}입니다. 전망대·능선·해안 데크에서는 난간에서 떨어져 걸으세요.`,
        );
        break;
      }
      case "rain": {
        const how =
          c.worst >= RAIN_WIND.PROB_HIGH_PCT
            ? "비가 올 것으로 봐야 합니다"
            : c.worst >= RAIN_WIND.PROB_MID_PCT
              ? "비가 올 가능성이 큽니다"
              : "비가 올 수 있습니다";
        add(
          bucket,
          `${when} 강수확률이 ${v}%로 ${how}. 우산을 챙기고, 비가 오면 대신 갈 실내 장소를 하나 정해 두세요.`,
        );
        break;
      }
      case "pm": {
        const grade = pmGradeLabel(c.worst);
        add(
          bucket,
          `${when} 미세먼지가 '${grade}'입니다(PM2.5 ${v}㎍/㎥). KF80 이상 마스크를 쓰고 야외에 오래 머물지 마세요.` +
            (withKids && c.worst > PM25.MODERATE_MAX
              ? " 아이는 바깥 활동 시간을 줄여 주세요."
              : ""),
        );
        break;
      }
      case "medical":
        add(
          bucket,
          `${c.worstTitle} — 가장 가까운 응급실이 ${v}km 떨어져 있습니다. 상비약을 챙기고 가는 길의 병원 위치를 미리 봐 두세요.` +
            (withSeniors ? " 부모님 복용약은 일정보다 넉넉히 챙기세요." : ""),
        );
        break;
    }
  }

  // 물가 스톱이 있는데 비가 예보됐다면, 계곡 사고는 비가 그친 뒤에도 난다
  const rain = found.get("rain");
  const heavy = found.get("heavy_rain");
  const waterAtRisk =
    (rain && rain.hasWater && rain.worst >= RAIN_WIND.PROB_MID_PCT) ||
    (heavy && heavy.hasWater);
  if (waterAtRisk) {
    add(
      "water",
      "계곡·물가 일정이 있습니다. 상류에 비가 오면 물이 순식간에 불어나니, 물이 흐려지거나 소리가 커지면 바로 물 밖으로 나오세요.",
    );
  }

  return out;
}
