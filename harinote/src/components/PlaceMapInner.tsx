"use client";

import { divIcon, latLngBounds } from "leaflet";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import Link from "next/link";
import "leaflet/dist/leaflet.css";
import type { PlaceMapProps } from "./PlaceMap";
import { roadKm } from "@/lib/reco/distance";

/** 기본 아이콘 이미지 의존 없이 CSS 원형 마커 사용 (번들러 아이콘 경로 문제 회피) */
function dotIcon(kind: "target" | "alt"): ReturnType<typeof divIcon> {
  const isTarget = kind === "target";
  const size = isTarget ? 22 : 16;
  const color = isTarget ? "#0f766e" : "#10b981";
  return divIcon({
    className: "",
    html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export default function PlaceMapInner({
  target,
  alternatives,
  profileQuery,
}: PlaceMapProps) {
  const points = [target, ...alternatives];
  // 점이 1개면 bounds가 크기 0으로 축퇴해 최대 줌이 되므로 center+zoom을 사용
  const view =
    points.length > 1
      ? {
          bounds: latLngBounds(
            points.map((p) => [p.lat, p.lng] as [number, number]),
          ).pad(0.2),
        }
      : { center: [target.lat, target.lng] as [number, number], zoom: 12 };

  return (
    <MapContainer
      {...view}
      scrollWheelZoom={false}
      className="z-0 h-72 w-full rounded-2xl ring-1 ring-slate-200"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Marker position={[target.lat, target.lng]} icon={dotIcon("target")}>
        <Popup>
          <strong>{target.title}</strong>
          <br />
          안전 점수 {target.score}점 (현재 관광지)
        </Popup>
      </Marker>
      {alternatives.map((alt) => (
        <Marker
          key={alt.contentId}
          position={[alt.lat, alt.lng]}
          icon={dotIcon("alt")}
        >
          <Popup>
            <strong>{alt.title}</strong>
            <br />
            안전 점수 {alt.score}점
            {alt.distanceKm !== undefined &&
              ` · 약 ${roadKm(alt.distanceKm).toFixed(1)}km`}
            <br />
            <Link
              href={`/places/${alt.contentId}${profileQuery}`}
              className="font-semibold text-teal-700"
            >
              상세 보기 →
            </Link>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
