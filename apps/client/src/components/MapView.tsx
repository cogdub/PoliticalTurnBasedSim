import { useEffect, useRef, useState } from "react";
import { Map as MLMap, NavigationControl, AttributionControl, setWorkerUrl, type GeoJSONSource, type ExpressionSpecification, type MapLayerMouseEvent } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
import type { MapData } from "../api";

export const COUNTRY_COLORS: Record<string, string> = {
  POL: "#d1495b", DEU: "#4a4e69", FRA: "#3d5a80", GBR: "#7b6d8d", USA: "#2f6690", CHN: "#b56576",
  RUS: "#5f7f63", UKR: "#e9c46a", BLR: "#a8a057", LTU: "#2a9d8f", TUR: "#c97c5d", ROW: "#555",
};

type Mode = "political" | "control" | "pressure" | "unrest";

export function MapView({ data, player, onSelectProvince, selected }: { data: MapData | null; player: string; onSelectProvince: (id: string | null) => void; selected: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>("control");
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const dataRef = useRef<MapData | null>(null);
  dataRef.current = data;

  useEffect(() => {
    if (!ref.current || map.current) return;
    const m = new MLMap({
      container: ref.current,
      style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#0e1a24" } }] },
      center: [28, 52],
      zoom: 3.6,
      attributionControl: false,
      renderWorldCopies: false,
    });
    m.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    m.addControl(new AttributionControl({ customAttribution: "Borders: Natural Earth (public domain); line of contact approximate" }), "bottom-left");
    m.on("load", async () => {
      const [backdrop, provinces] = await Promise.all([fetch("/api/geo/backdrop").then((r) => r.json()), fetch("/api/geo/provinces").then((r) => r.json())]);
      m.addSource("backdrop", { type: "geojson", data: backdrop });
      m.addLayer({ id: "backdrop-fill", type: "fill", source: "backdrop", paint: { "fill-color": "#2a3440", "fill-opacity": 0.9 } });
      m.addLayer({ id: "backdrop-line", type: "line", source: "backdrop", paint: { "line-color": "#46525e", "line-width": 0.5 } });
      m.addSource("prov", { type: "geojson", data: provinces, promoteId: "id" });
      m.addLayer({ id: "prov-fill", type: "fill", source: "prov", paint: { "fill-color": "#555", "fill-opacity": 0.85 } });
      m.addLayer({ id: "prov-line", type: "line", source: "prov", paint: { "line-color": "#0e1a24", "line-width": 0.6 } });
      m.addLayer({ id: "prov-occupied", type: "line", source: "prov", paint: { "line-color": "#ff4d4d", "line-width": ["case", ["boolean", ["feature-state", "occupied"], false], 2, 0], "line-dasharray": [2, 1.5] } });
      m.addLayer({ id: "prov-selected", type: "line", source: "prov", paint: { "line-color": "#ffffff", "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 2.5, 0] } });
      m.addSource("units", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "units", type: "circle", source: "units", paint: { "circle-radius": ["interpolate", ["linear"], ["get", "k"], 1, 4, 300, 12], "circle-color": ["get", "color"], "circle-stroke-color": ["case", ["get", "own"], "#fff", "#111"], "circle-stroke-width": 1.5, "circle-opacity": ["case", ["get", "estimated"], 0.6, 0.95] } });
      m.on("mousemove", "prov-fill", (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        const p = dataRef.current?.provinces.find((x) => x.id === f?.properties?.id);
        if (!p) return;
        const occ = p.owner !== p.controller ? ` — held by ${p.controller}` : "";
        setHover({ x: e.point.x, y: e.point.y, text: `${p.name} (${p.owner})${occ}${p.pressure ? ` · front pressure ${p.pressure}%` : ""}` });
      });
      m.on("mouseleave", "prov-fill", () => setHover(null));
      m.on("click", "prov-fill", (e: MapLayerMouseEvent) => onSelectProvince((e.features?.[0]?.properties?.id as string) ?? null));
      setReady(true);
    });
    map.current = m;
  }, [onSelectProvince]);

  // Re-colour provinces via feature-state when data or mode changes (no geometry regeneration).
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !data) return;
    const colorExpr: ExpressionSpecification = ["coalesce", ["feature-state", "color"], "#555"];
    m.setPaintProperty("prov-fill", "fill-color", colorExpr);
    for (const p of data.provinces) {
      let color: string;
      if (mode === "political") color = COUNTRY_COLORS[p.owner] ?? "#666";
      else if (mode === "control") color = COUNTRY_COLORS[p.controller] ?? "#666";
      else if (mode === "pressure") color = p.pressure > 0 ? `rgba(255,${Math.round(200 - p.pressure * 1.6)},60,1)` : p.controller === player ? "#3a4a58" : "#2c3640";
      else color = `rgb(${60 + p.unrest * 1.9},${80 - p.unrest * 0.5},${90 - p.unrest * 0.6})`;
      m.setFeatureState({ source: "prov", id: p.id }, { color, occupied: p.owner !== p.controller, selected: p.id === selected });
    }
    const byLoc = new Map<string, { k: number; own: boolean; country: string; estimated: boolean; names: string[] }>();
    for (const u of data.units) {
      const key = `${u.location}:${u.country}`;
      const cur = byLoc.get(key) ?? { k: 0, own: u.own, country: u.country, estimated: u.reliability !== "confirmed", names: [] };
      cur.k += u.personnel / 1000;
      cur.names.push(u.name);
      byLoc.set(key, cur);
    }
    const feats = [...byLoc.entries()].map(([key, v], i) => {
      const prov = data.provinces.find((p) => p.id === key.split(":")[0]);
      const offset = (i % 3) * 0.25;
      return { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [(prov?.lon ?? 0) + offset, (prov?.lat ?? 0) - offset * 0.5] }, properties: { k: v.k, own: v.own, color: COUNTRY_COLORS[v.country] ?? "#999", estimated: v.estimated } };
    });
    (m.getSource("units") as GeoJSONSource).setData({ type: "FeatureCollection", features: feats });
  }, [data, mode, ready, player, selected]);

  return (
    <div className="map-wrap">
      <div ref={ref} className="map" />
      <div className="map-modes">
        {(["control", "political", "pressure", "unrest"] as Mode[]).map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
            {m === "control" ? "Military control" : m === "political" ? "Legal owner" : m === "pressure" ? "Front lines" : "Unrest"}
          </button>
        ))}
      </div>
      {hover && <div className="map-tip" style={{ left: hover.x + 12, top: hover.y + 12 }}>{hover.text}</div>}
    </div>
  );
}
