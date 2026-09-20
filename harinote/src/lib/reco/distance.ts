/** 두 좌표 간 대원거리(km) — Haversine 공식 (지구 반경 6371km 가정) */
const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/**
 * 직선거리 → 도로거리 추정 배율(우회계수).
 *
 * **표시 전용이다.** 후보 탐색 반경·추천 순위는 직선거리를 그대로 쓴다 —
 * 반경(점심 10km·오후 15km·대체지 30km 등)은 직선 기준으로 정해진 값이라
 * 여기에 계수를 걸면 근거 없이 후보가 좁아진다. 사용자에게 보이는 숫자만
 * 실제 이동에 가깝게 옮기고, 무엇을 추천할지는 건드리지 않는다.
 *
 * 근거 등급 🟡 — 프로젝트 내부 관례값이지 강원 도로망 실측이 아니다.
 *   analysis/11_medical_curve.py가 119 출동 기록의 도로거리↔소요시간을 회귀할 때
 *   직선거리를 도로거리로 환산하며 채택한 계수와 같은 값이다
 *   (weights.ts MEDICAL 주석 "직선거리는 우회계수 1.3 적용" 참조).
 *   강원 산악도로는 이보다 클 수 있으므로 화면에는 항상 "약"으로 표기한다.
 */
export const ROAD_DETOUR_FACTOR = 1.3;

/**
 * 직선거리(km) → 도로거리 추정(km), 소수 1자리.
 * 순위·필터에는 쓰지 말 것 — ROAD_DETOUR_FACTOR 주석 참조.
 */
export function roadKm(straightKm: number): number {
  return Math.round(straightKm * ROAD_DETOUR_FACTOR * 10) / 10;
}
