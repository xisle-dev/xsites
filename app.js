// xsite — Google satellite imagery draped over AWS global DEM terrain.
//
// Same gtiles:// session-protocol bridge as dem-compare / vancouver-island-3d-map
// for fetching Google's authenticated 2D satellite tiles. Terrain uses AWS's
// global Terrarium-encoded elevation-tiles-prod DEM (~30m resolution).
import {
  Map,
  Marker,
  ScaleControl,
  addProtocol,
} from "https://cdn.jsdelivr.net/npm/maplibre-gl@6.7.0/dist/maplibre-gl.mjs";
import { layers as pmLayers, namedFlavor } from "https://cdn.jsdelivr.net/npm/@protomaps/basemaps@5.7.2/dist/esm/index.js";

// Same key already used in dem-compare / vancouver-island-3d-map. Swap for
// your own if this one is rotated/revoked.
const GOOGLE_MAPS_API_KEY = "AIzaSyC6B3ghaO13sBDNQa68oSYhPJukPLLXR2o";

let googleSession = null; // { token, expiry: <unix seconds> }

async function ensureGoogleSession() {
  const nowSeconds = Date.now() / 1000;
  if (googleSession && googleSession.expiry - nowSeconds > 60) {
    return googleSession;
  }
  const res = await fetch(
    `https://tile.googleapis.com/v1/createSession?key=${GOOGLE_MAPS_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mapType: "satellite",
        language: "en-US",
        region: "US",
        // No layerRoadmap: Google bakes road/place labels into the raster
        // pixels, so they rotate (and go upside-down) with map bearing.
        // Labels come from the Protomaps vector tile layer below instead,
        // which stays upright at any bearing.
        layerTypes: [],
        overlay: false,
        scale: "scaleFactor1x",
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google createSession failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  googleSession = { token: data.session, expiry: Number(data.expiry) };
  return googleSession;
}

addProtocol("gtiles", async (params, abortController) => {
  const match = params.url.match(/^gtiles:\/\/(\d+)\/(\d+)\/(\d+)/);
  if (!match) {
    throw new Error(`Unrecognized gtiles:// URL: ${params.url}`);
  }
  const [, z, x, y] = match;
  const session = await ensureGoogleSession();
  const tileUrl = `https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${session.token}&key=${GOOGLE_MAPS_API_KEY}`;
  const response = await fetch(tileUrl, { signal: abortController.signal });
  if (!response.ok) {
    throw new Error(`Google tile fetch failed (${response.status}): ${tileUrl}`);
  }
  const data = await response.arrayBuffer();
  return { data };
});

const START = {
  center: [-126.155, 49.365],
  zoom: 12,
  pitch: 0,
  bearing: 0,
};

// MapLibre warns (and renders worse) if one raster-dem source is used both
// for a hillshade layer AND for setTerrain() at the same time — use two
// separate sources pointed at the same tile template so terrain exaggeration
// updates aren't contending with the hillshade layer's own use of that
// source (see dem-compare's app.js for the full writeup of this failure mode).
const HILLSHADE_SOURCE_ID = "dem-hillshade";
const TERRAIN_SOURCE_ID = "dem-terrain";
const SAT_SOURCE_ID = "satellite";
const SAT_LAYER_ID = "satellite-layer";
const LABELS_SOURCE_ID = "labels";
const AIRSPACE_SOURCE_ID = "airspace";
const AIRSPACE_FILL_LAYER_ID = "airspace-fill";
const AIRSPACE_LINE_LAYER_ID = "airspace-line";
const AIRSPACE_HIGHLIGHT_SOURCE_ID = "airspace-highlight";
const AIRSPACE_HIGHLIGHT_LAYER_ID = "airspace-highlight-line";
const AIRSPACE_HIGHLIGHT_VOLUME_LAYER_ID = "airspace-highlight-volume";
const AIRSPACE_HIGHLIGHT_LABEL_LAYER_ID = "airspace-highlight-label";

// Canadian airspace (NAV CANADA data via OpenAIP, CC BY-NC 4.0), pre-filtered
// to the Vancouver Island flying area by tools/fetchairspace -- see that
// tool's header comment for how the icaoClass -> letter mapping was derived
// (OpenAIP's own docs don't spell it out).
const AIRSPACE_COLORS = { B: "#3b82f6", C: "#ec4899", D: "#22d3ee", E: "#a78bfa", F: "#f97316", SUA: "#ef4444" };
const airspaceColorExpr = [
  "match", ["get", "class"],
  "B", AIRSPACE_COLORS.B,
  "C", AIRSPACE_COLORS.C,
  "D", AIRSPACE_COLORS.D,
  "E", AIRSPACE_COLORS.E,
  "F", AIRSPACE_COLORS.F,
  "SUA", AIRSPACE_COLORS.SUA,
  "#999999",
];

// Place/road/city labels as real vector text (Protomaps basemap extract,
// served locally by go-pmtiles), instead of Google's raster labels which
// are baked into the imagery pixels and rotate (upside-down at bearing
// 180°) with the map. Point labels use text-rotation-alignment: "viewport"
// in the Protomaps style so they always stay upright; road labels follow
// their line but MapLibre's default text-keep-upright flips them so they
// never render upside-down either.
// Text only, no sprite icons (park/POI markers etc.) -- we're not loading
// Protomaps' sprite sheet, so stripping icon-image avoids missing-image
// console warnings for layers that would otherwise draw a blank icon.
const labelLayers = pmLayers(LABELS_SOURCE_ID, namedFlavor("dark"), { lang: "en" })
  .filter((l) => l.type === "symbol" && l.layout?.["text-field"])
  .map((l) => {
    const layout = { ...l.layout };
    delete layout["icon-image"];
    return { ...l, layout };
  });

// Scale a text-size value/expression by `factor`. Handles the two shapes
// the basemap style actually uses: a plain number, or a zoom "interpolate"
// expression (["interpolate", interp, ["zoom"], zoom1, size1, zoom2, size2, ...]
// -- sizes are the even-indexed entries starting at 4).
function scaleTextSize(expr, factor) {
  if (typeof expr === "number") return expr * factor;
  if (Array.isArray(expr) && expr[0] === "interpolate") {
    const copy = JSON.parse(JSON.stringify(expr));
    for (let i = 4; i < copy.length; i += 2) copy[i] *= factor;
    return copy;
  }
  return expr;
}

// Pull the entries matching `kind` out of a layer sharing one filter/style
// across many kinds, into their own layer, so they can be sized/zoomed
// independently without affecting the rest of that layer's features.
function splitOutKind(layers, layerId, kind, restFilter, extractedFilter, tweak) {
  const idx = layers.findIndex((l) => l.id === layerId);
  if (idx === -1) return layers;
  const base = layers[idx];
  const rest = { ...base, filter: restFilter };
  const extracted = tweak({ ...base, id: `${layerId}_${kind}`, filter: extractedFilter });
  const next = layers.slice();
  next.splice(idx, 1, rest, extracted);
  return next;
}

let tunedLabelLayers = labelLayers;

// Mountain peak labels live inside the shared "pois" layer (park, cafe,
// museum, ... all one layer/filter). Split peaks out: 1.5x text size, and
// visible 2 zoom levels earlier than the basemap default (each pois feature
// carries its own min_zoom; the shared layer gates on zoom >= min_zoom + 0).
{
  const pois = tunedLabelLayers.find((l) => l.id === "pois");
  if (pois) {
    const kinds = pois.filter[1][2][1]; // ["all", ["in", ["get","kind"], ["literal", [...]]], zoomExpr]
    tunedLabelLayers = splitOutKind(
      tunedLabelLayers,
      "pois",
      "peak",
      ["all", ["in", ["get", "kind"], ["literal", kinds.filter((k) => k !== "peak")]], pois.filter[2]],
      ["all", ["==", ["get", "kind"], "peak"], [">=", ["zoom"], ["+", ["get", "min_zoom"], -2]]],
      (l) => ({ ...l, layout: { ...l.layout, "text-size": scaleTextSize(l.layout["text-size"], 1.5) } })
    );
  }
}

// Trail names live inside "roads_labels_minor" alongside minor roads and
// "other" -- same treatment: 1.5x text size, minzoom 2 levels earlier.
{
  const roadsMinor = tunedLabelLayers.find((l) => l.id === "roads_labels_minor");
  if (roadsMinor) {
    tunedLabelLayers = splitOutKind(
      tunedLabelLayers,
      "roads_labels_minor",
      "path",
      ["in", ["get", "kind"], ["literal", ["minor_road", "other"]]],
      ["==", ["get", "kind"], "path"],
      (l) => ({
        ...l,
        minzoom: Math.max(0, (l.minzoom ?? 0) - 2),
        layout: { ...l.layout, "text-size": scaleTextSize(l.layout["text-size"], 1.5) },
      })
    );
  }
}

const demSourceDef = {
  type: "raster-dem",
  tiles: ["https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"],
  tileSize: 256,
  encoding: "terrarium",
  maxzoom: 15,
  minzoom: 0,
};

const style = {
  version: 8,
  sources: {
    [HILLSHADE_SOURCE_ID]: { ...demSourceDef },
    [TERRAIN_SOURCE_ID]: { ...demSourceDef },
    [SAT_SOURCE_ID]: {
      type: "raster",
      tiles: ["gtiles://{z}/{x}/{y}"],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 20,
      attribution: "© Google",
    },
    [LABELS_SOURCE_ID]: {
      type: "vector",
      // MapLibre's tile worker runs from a blob: URL with no page base to
      // resolve a relative URL against, so this has to be absolute even
      // though it's same-origin.
      tiles: [`${window.location.origin}/tiles/labels-vancouver-island/{z}/{x}/{y}.mvt`],
      minzoom: 0,
      maxzoom: 15,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    [AIRSPACE_SOURCE_ID]: {
      type: "geojson",
      // Absolute for the same reason as LABELS_SOURCE_ID above.
      data: `${window.location.origin}/data/airspace.geojson`,
      attribution: '© <a href="https://www.openaip.net" target="_blank" rel="noopener">OpenAIP</a> contributors (CC BY-NC 4.0)',
    },
    [AIRSPACE_HIGHLIGHT_SOURCE_ID]: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    },
  },
  layers: [
    {
      id: "bg",
      type: "background",
      paint: { "background-color": "#c9cdd2" },
    },
    {
      id: "hillshade",
      type: "hillshade",
      source: HILLSHADE_SOURCE_ID,
      paint: {
        "hillshade-exaggeration": 0.7,
        "hillshade-illumination-direction": 315,
        "hillshade-shadow-color": "#1b1f26",
        "hillshade-highlight-color": "#ffffff",
        "hillshade-accent-color": "#5a6472",
      },
    },
    {
      id: SAT_LAYER_ID,
      type: "raster",
      source: SAT_SOURCE_ID,
      // Left below full opacity so the hillshade underneath still shows
      // through — imagery alone often reads flatter than the terrain mesh
      // actually is, especially over uniform forest canopy.
      paint: { "raster-opacity": 0.92 },
    },
    {
      id: AIRSPACE_FILL_LAYER_ID,
      type: "fill",
      source: AIRSPACE_SOURCE_ID,
      paint: { "fill-color": airspaceColorExpr, "fill-opacity": 0.18 },
    },
    {
      id: AIRSPACE_LINE_LAYER_ID,
      type: "line",
      source: AIRSPACE_SOURCE_ID,
      paint: { "line-color": airspaceColorExpr, "line-width": 1.5, "line-opacity": 0.85 },
    },
    {
      // Traces whichever airspace entry the pointer is over in the click
      // popup's list -- fed by setAirspaceHighlight, empty otherwise.
      id: AIRSPACE_HIGHLIGHT_LAYER_ID,
      type: "line",
      source: AIRSPACE_HIGHLIGHT_SOURCE_ID,
      paint: { "line-color": "#ffffff", "line-width": 3.5, "line-opacity": 0.95 },
    },
    {
      // Real floor-to-ceiling volume, but only for the single currently
      // highlighted entry -- every other airspace region stays flat 2D, so
      // hovering doesn't turn the whole map into a forest of glass boxes.
      // extrusionBase/extrusionTop are computed (terrain-corrected) and
      // attached to the feature in setAirspaceHighlight.
      id: AIRSPACE_HIGHLIGHT_VOLUME_LAYER_ID,
      type: "fill-extrusion",
      source: AIRSPACE_HIGHLIGHT_SOURCE_ID,
      paint: {
        "fill-extrusion-color": "#ffffff",
        "fill-extrusion-opacity": 0.35,
        "fill-extrusion-base": ["get", "extrusionBase"],
        "fill-extrusion-height": ["get", "extrusionTop"],
      },
    },
    ...tunedLabelLayers,
    {
      // All the text info the panel row shows (name, class, floor/ceiling),
      // put directly on the map next to whatever's highlighted -- last in
      // the stack so it's never covered by a place-name label.
      id: AIRSPACE_HIGHLIGHT_LABEL_LAYER_ID,
      type: "symbol",
      source: AIRSPACE_HIGHLIGHT_SOURCE_ID,
      layout: {
        "text-field": ["concat", ["get", "name"], " (", ["get", "class"], ")\n", ["get", "floor"], " – ", ["get", "ceiling"]],
        "text-size": 13,
        "text-anchor": "center",
        "text-justify": "center",
        "text-max-width": 14,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#000000",
        "text-halo-width": 1.5,
      },
    },
  ],
};

const map = new Map({
  container: "map",
  style,
  center: START.center,
  zoom: START.zoom,
  pitch: START.pitch,
  bearing: START.bearing,
  attributionControl: false,
});

window.map = map;

map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");

document.getElementById("zoomInBtn").addEventListener("click", () => map.zoomIn({ duration: 200 }));
document.getElementById("zoomOutBtn").addEventListener("click", () => map.zoomOut({ duration: 200 }));

let exaggeration = 1.5;

function applyTerrain() {
  try {
    map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
    map.triggerRepaint();
  } catch (e) {
    console.error("[terrain] setTerrain failed:", e);
  }
}

map.on("load", applyTerrain);

// --- UI wiring ---

const pitchInput = document.getElementById("pitch");
const pitchValue = document.getElementById("pitchValue");
pitchInput.addEventListener("input", (e) => {
  const value = parseFloat(e.target.value);
  pitchValue.textContent = Math.round(value);
  map.easeTo({ pitch: value, duration: 150 });
});

const exaggerationInput = document.getElementById("exaggeration");
const exaggerationValue = document.getElementById("exaggerationValue");
exaggerationInput.addEventListener("input", (e) => {
  exaggeration = parseFloat(e.target.value);
  exaggerationValue.textContent = exaggeration.toFixed(1);
  applyTerrain();
});

// Map Controls (pitch/exaggeration/airspace legend) lives in a dropdown off
// the hamburger button in the header, not inline in the panel/sheet -- closes
// on a second click of the button or a click anywhere outside it.
const mapControlsMenu = document.getElementById("mapControlsMenu");
const mapControlsToggle = document.getElementById("mapControlsToggle");
const terrainContent = document.getElementById("terrainContent");
mapControlsToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  const expanded = mapControlsToggle.getAttribute("aria-expanded") === "true";
  mapControlsToggle.setAttribute("aria-expanded", String(!expanded));
  terrainContent.hidden = expanded;
});
document.addEventListener("click", (e) => {
  if (!terrainContent.hidden && !mapControlsMenu.contains(e.target)) {
    mapControlsToggle.setAttribute("aria-expanded", "false");
    terrainContent.hidden = true;
  }
});

// Keep the pitch slider in sync when pitch changes some other way (flyTo,
// drag-to-rotate-and-pitch), not just via the slider itself.
map.on("pitch", () => {
  const p = map.getPitch();
  pitchInput.value = p;
  pitchValue.textContent = Math.round(p);
});

// --- Bottom sheet (mobile) ---
//
// Below the CSS breakpoint, #panel becomes a bottom sheet instead of a
// fixed left-side panel (see style.css). #panelHandle toggles between
// collapsed (just the brand row peeking above the map) and expanded, and
// also supports dragging to an arbitrary height that snaps to whichever
// state it's closer to on release -- both live on the same pointer
// listeners so a plain tap (no movement) is treated as a toggle.

const panel = document.getElementById("panel");
const panelHandle = document.getElementById("panelHandle");
const SHEET_COLLAPSED_HEIGHT = 64;

function isMobileSheet() {
  return window.matchMedia("(max-width: 700px)").matches;
}

// Used whenever new content appears (a site or airspace selection) so it's
// actually visible instead of clipped behind a collapsed sheet.
function expandPanel() {
  panel.classList.remove("sheet-collapsed");
}

if (panelHandle) {
  let dragStartY = null;
  let dragStartHeight = null;
  let dragMoved = false;

  panelHandle.addEventListener("pointerdown", (e) => {
    if (!isMobileSheet()) return;
    dragStartY = e.clientY;
    dragStartHeight = panel.getBoundingClientRect().height;
    dragMoved = false;
    panel.style.transition = "none";
  });

  // Tracked on document, not the handle -- a real drag routinely carries
  // the pointer off such a small target, and capturing the pointer to the
  // handle element also confuses at least one automated click driver.
  document.addEventListener("pointermove", (e) => {
    if (dragStartY === null) return;
    const delta = dragStartY - e.clientY;
    if (Math.abs(delta) > 4) dragMoved = true;
    const expandedMax = window.innerHeight / 3;
    const next = Math.min(expandedMax, Math.max(SHEET_COLLAPSED_HEIGHT, dragStartHeight + delta));
    panel.style.maxHeight = `${next}px`;
  });

  function endDrag() {
    if (dragStartY === null) return;
    dragStartY = null;
    panel.style.transition = "";
    if (dragMoved) {
      const expandedMax = window.innerHeight / 3;
      const midpoint = (SHEET_COLLAPSED_HEIGHT + expandedMax) / 2;
      const currentHeight = panel.getBoundingClientRect().height;
      panel.classList.toggle("sheet-collapsed", currentHeight < midpoint);
    } else {
      panel.classList.toggle("sheet-collapsed");
    }
    panel.style.maxHeight = "";
  }
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
}

// --- Airspace overlay ---

const airspaceToggle = document.getElementById("airspaceToggle");
const airspaceLegend = document.getElementById("airspaceLegend");
const airspaceClassCheckboxes = [...airspaceLegend.querySelectorAll("input[data-airspace-class]")];

function applyAirspaceFilter() {
  const visibleClasses = airspaceClassCheckboxes.filter((cb) => cb.checked).map((cb) => cb.dataset.airspaceClass);
  const filter = ["in", ["get", "class"], ["literal", visibleClasses]];
  map.setFilter(AIRSPACE_FILL_LAYER_ID, filter);
  map.setFilter(AIRSPACE_LINE_LAYER_ID, filter);
}

function applyAirspaceVisibility() {
  const visibility = airspaceToggle.checked ? "visible" : "none";
  map.setLayoutProperty(AIRSPACE_FILL_LAYER_ID, "visibility", visibility);
  map.setLayoutProperty(AIRSPACE_LINE_LAYER_ID, "visibility", visibility);
  airspaceLegend.classList.toggle("airspace-legend-disabled", !airspaceToggle.checked);
}

map.on("load", () => {
  applyAirspaceFilter();
  applyAirspaceVisibility();
});
airspaceToggle.addEventListener("change", applyAirspaceVisibility);
airspaceClassCheckboxes.forEach((cb) => cb.addEventListener("change", applyAirspaceFilter));

// Traces the given geometry (or clears the trace if null) in the highlight
// layer, carrying `properties` along so the label layer can show the same
// name/class/floor/ceiling the panel row does -- used so hovering a panel
// entry shows which polygon on the map it refers to, with its full details,
// without having to look back at the panel to read them.
//
// `properties` here is a Feature.properties object handed back by
// queryRenderedFeatures, which isn't a plain Object -- passing it straight
// into setData() makes the source silently drop the feature entirely
// (setData()/isSourceLoaded() both still report success, but nothing is
// ever tiled or rendered, and there's no error to catch). Spreading it into
// a genuine plain object first fixes it.
// Rough centroid (mean vertex of its largest ring) of a Polygon/
// MultiPolygon, used only as a sample point for queryTerrainElevation --
// doesn't need to be precise, just reliably inside the shape.
function polygonCentroid(geometry) {
  const rings =
    geometry.type === "Polygon"
      ? [geometry.coordinates[0]]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates.map((poly) => poly[0])
        : [];
  let bestRing = null;
  let bestArea = -1;
  for (const ring of rings) {
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    area = Math.abs(area);
    if (area > bestArea) {
      bestArea = area;
      bestRing = ring;
    }
  }
  if (!bestRing) return null;
  let x = 0;
  let y = 0;
  for (const [lon, lat] of bestRing) {
    x += lon;
    y += lat;
  }
  return [x / bestRing.length, y / bestRing.length];
}

// Caps the highlight volume's height above its base so an SFC-FL999 FIR
// boundary (or similarly tall SUA) still renders as a visible wall instead
// of an unusable ~30km-tall column.
const MAX_HIGHLIGHT_EXTRUSION_M = 3500;

// Converts a feature's floorM/ceilingM (each either already ground-relative
// ("GND") or sea-level-referenced ("MSL") -- see tools/fetchairspace's
// outProperties comment) into base/top meters for the highlight
// fill-extrusion layer, which is itself ground-relative once terrain is on.
// MSL values need the local ground elevation at the shape subtracted.
function computeExtrusionRange(geometry, props) {
  const { floorM, floorDatum, ceilingM, ceilingDatum } = props;
  if (typeof floorM !== "number" || typeof ceilingM !== "number") return [0, 0];
  const centroid = polygonCentroid(geometry);
  let groundElevation = 0;
  if (centroid) {
    const elevation = map.queryTerrainElevation({ lng: centroid[0], lat: centroid[1] });
    if (typeof elevation === "number") groundElevation = elevation;
  }
  const base = floorDatum === "MSL" ? Math.max(0, floorM - groundElevation) : floorM;
  const rawTop = ceilingDatum === "MSL" ? Math.max(base, ceilingM - groundElevation) : ceilingM;
  const top = Math.min(rawTop, base + MAX_HIGHLIGHT_EXTRUSION_M);
  return [base, top];
}

function setAirspaceHighlight(geometry, properties) {
  const source = map.getSource(AIRSPACE_HIGHLIGHT_SOURCE_ID);
  if (!source) return;
  if (!geometry) {
    source.setData({ type: "FeatureCollection", features: [] });
    return;
  }
  const plainProps = { ...properties };
  const [extrusionBase, extrusionTop] = computeExtrusionRange(geometry, plainProps);
  plainProps.extrusionBase = extrusionBase;
  plainProps.extrusionTop = extrusionTop;
  source.setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry, properties: plainProps }] });
}

// Airspace selections share the same panel/sheet as the sites list and
// detail view (see #airspaceListView in index.html), rather than a
// separate floating map popup -- one UI surface instead of two, and it's
// the only sensible option once that surface is a bottom sheet on mobile
// (a map popup would be pinned to a point that's often hidden behind it).
const airspaceListView = document.getElementById("airspaceListView");
const airspaceEntries = document.getElementById("airspaceEntries");
document.getElementById("airspaceBackBtn").addEventListener("click", showListView);

function showAirspaceList(entries) {
  stopPlacing();
  sitesListView.hidden = true;
  siteDetailView.hidden = true;
  siteForm.hidden = true;
  airspaceListView.hidden = false;
  expandPanel();

  airspaceEntries.innerHTML = "";
  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "site-item";
    const nameEl = document.createElement("div");
    nameEl.className = "site-name";
    nameEl.textContent = entry.properties.name;
    const classSpan = document.createElement("span");
    classSpan.className = "airspace-entry-class";
    classSpan.textContent = ` (${entry.properties.class})`;
    nameEl.appendChild(classSpan);
    const limitsEl = document.createElement("div");
    limitsEl.className = "site-area";
    limitsEl.textContent = `${entry.properties.floor} – ${entry.properties.ceiling}`;
    row.append(nameEl, limitsEl);
    row.addEventListener("mouseenter", () => setAirspaceHighlight(entry.geometry, entry.properties));
    row.addEventListener("mouseleave", () => setAirspaceHighlight(null));
    airspaceEntries.appendChild(row);
  });
}

map.on("click", AIRSPACE_FILL_LAYER_ID, (e) => {
  // Don't show airspace info while the user is trying to place/reposition
  // a site pin -- let the general click handler below handle it instead.
  if (placingMode) return;
  if (!e.features || e.features.length === 0) return;
  // A click point commonly sits inside several stacked airspace volumes at
  // once (e.g. a Class E floor under a Class B shelf) -- list all of them,
  // not just whichever rendered on top. De-duped since a feature can be
  // reported more than once where it crosses a tile boundary.
  const seen = new Set();
  const entries = [];
  for (const f of e.features) {
    const p = f.properties;
    const key = `${p.name}|${p.class}|${p.floor}|${p.ceiling}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ properties: p, geometry: f.geometry });
  }
  showAirspaceList(entries);
});
map.on("mouseenter", AIRSPACE_FILL_LAYER_ID, () => { map.getCanvas().style.cursor = "pointer"; });
map.on("mouseleave", AIRSPACE_FILL_LAYER_ID, () => { map.getCanvas().style.cursor = ""; });

// --- Sites: markers + CRUD against the local /api/sites backend ---

let sites = [];
const markersById = {};
// null while inactive; "new" while placing a brand-new site (from the list's
// "+ Add" button, before any form is open); "reposition" while updating the
// pin of whichever form (add or edit) is currently open.
let placingMode = null;
let editingId = null; // null while adding a new site
let formView = null; // {latitude, longitude, zoom, bearing, pitch} camera preset for the form in progress

const sitesListView = document.getElementById("sitesListView");
const siteDetailView = document.getElementById("siteDetailView");
const siteForm = document.getElementById("siteForm");
const siteList = document.getElementById("siteList");
const siteSearch = document.getElementById("siteSearch");
const areaFilter = document.getElementById("areaFilter");
const siteDetailContent = document.getElementById("siteDetailContent");
const placingBanner = document.getElementById("placingBanner");
const fViewSummary = document.getElementById("fViewSummary");

// The existing site data was originally authored with Quill (its "ql-ui"
// spans and data-list attributes show up in a few description/hazards
// fields already) -- using it here too keeps new edits in the same HTML
// shape as the rest of the dataset instead of introducing a second dialect.
const richTextToolbar = [[{ header: [3, false] }], ["bold", "italic"], [{ list: "ordered" }, { list: "bullet" }], ["link"], ["clean"]];
const descriptionEditor = new window.Quill("#fDescription", { theme: "snow", modules: { toolbar: richTextToolbar } });
const hazardsEditor = new window.Quill("#fHazards", { theme: "snow", modules: { toolbar: richTextToolbar } });

// Keep the toolbar out of the way until the editor actually has the cursor.
// Quill's own toolbar buttons preventDefault on mousedown specifically so
// clicking them doesn't blur the editor first, so this doesn't fight itself.
for (const editor of [descriptionEditor, hazardsEditor]) {
  const toolbar = editor.getModule("toolbar").container;
  toolbar.classList.add("rte-toolbar-hidden");
  editor.on("selection-change", (range) => {
    toolbar.classList.toggle("rte-toolbar-hidden", !range);
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

async function loadSites() {
  sites = await api("/api/sites");
  populateAreaFilter();
  renderMarkers();
  renderSiteList();
  fitToVisibleSites();
}

// The search box and area dropdown together define "visible": both the
// marker set on the map and the sidebar list are this same set, so they
// never disagree about what's currently shown.
function getFilteredSites() {
  const q = siteSearch.value.trim().toLowerCase();
  const area = areaFilter.value;
  return sites
    .filter((s) => !area || s.area === area)
    .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.area || "").toLowerCase().includes(q));
}

// Zoom/pan to the bounding box of the currently-visible pins plus a 10%
// buffer on each side, so the visible set is framed without markers sitting
// right at the viewport edge.
function fitToVisibleSites() {
  const pinned = getFilteredSites().filter((s) => typeof s.latitude === "number" && typeof s.longitude === "number");
  if (pinned.length === 0) return;

  const lats = pinned.map((s) => s.latitude);
  const lngs = pinned.map((s) => s.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  // 10% of the span, with a floor so a single pin (or a cluster of
  // near-identical coordinates) still gets a sensible amount of context
  // around it instead of an essentially zero-size bounds.
  const latBuffer = Math.max((maxLat - minLat) * 0.1, 0.01);
  const lngBuffer = Math.max((maxLng - minLng) * 0.1, 0.01);

  map.fitBounds(
    [
      [minLng - lngBuffer, minLat - latBuffer],
      [maxLng + lngBuffer, maxLat + latBuffer],
    ],
    { duration: 0 }
  );
}

function renderMarkers() {
  for (const id in markersById) markersById[id].remove();
  for (const id in markersById) delete markersById[id];
  for (const site of getFilteredSites()) {
    if (typeof site.latitude !== "number" || typeof site.longitude !== "number") continue;
    const el = document.createElement("div");
    el.className = "site-marker";
    el.title = site.name;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      showDetail(site.id);
    });
    const marker = new Marker({ element: el, anchor: "bottom" })
      .setLngLat([site.longitude, site.latitude])
      .addTo(map);
    markersById[site.id] = marker;
  }
}

function populateAreaFilter() {
  const areas = [...new Set(sites.map((s) => s.area).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const current = areaFilter.value;
  areaFilter.innerHTML =
    `<option value="">All areas</option>` +
    areas.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
  if (areas.includes(current)) areaFilter.value = current;
}

function renderSiteList() {
  const filtered = getFilteredSites().slice().sort((a, b) => a.name.localeCompare(b.name));
  siteList.innerHTML = filtered
    .map(
      (s) => `
        <div class="site-item" data-id="${escapeHtml(s.id)}">
          <div class="site-name">${escapeHtml(s.name)}</div>
          <div class="site-area">${escapeHtml(s.area || "")}</div>
        </div>`
    )
    .join("");
  siteList.querySelectorAll(".site-item").forEach((el) => {
    el.addEventListener("click", () => showDetail(el.dataset.id));
  });
}

// Re-applying the search text or area dropdown re-derives both the marker
// set and the list, then reframes the map on whatever's now visible.
function applyFilters() {
  renderMarkers();
  renderSiteList();
  fitToVisibleSites();
}
siteSearch.addEventListener("input", applyFilters);
areaFilter.addEventListener("change", applyFilters);

function flyToSite(site) {
  map.flyTo({
    center: [site.view_longitude ?? site.longitude, site.view_latitude ?? site.latitude],
    zoom: site.view_zoom ?? 13,
    bearing: site.view_bearing ?? 0,
    pitch: site.view_pitch ?? 0,
    duration: 1500,
  });
}

function showListView() {
  stopPlacing();
  sitesListView.hidden = false;
  siteDetailView.hidden = true;
  siteForm.hidden = true;
  airspaceListView.hidden = true;
}

function showDetail(id) {
  stopPlacing();
  const site = sites.find((s) => s.id === id);
  if (!site) return;
  sitesListView.hidden = true;
  siteForm.hidden = true;
  airspaceListView.hidden = true;
  siteDetailView.hidden = false;
  expandPanel();

  const photos = (site.references || []).filter((r) => r.type === "photo");
  siteDetailContent.innerHTML = `
    <h3>${escapeHtml(site.name)}</h3>
    <div class="site-area">${escapeHtml(site.area || "")}</div>
    <div class="stat-row">
      <span>${site.elevation_m ? Math.round(site.elevation_m) + " m" : "–"}</span>
      <span>${site.latitude.toFixed(5)}, ${site.longitude.toFixed(5)}</span>
    </div>

    <div class="section-label">Description</div>
    <div class="rich">${site.description || ""}</div>

    <div class="section-label">Hazards</div>
    <div class="rich">${site.hazards || ""}</div>

    <div class="section-label">Photos</div>
    <div class="media-grid" id="mediaGrid"></div>
    <input type="file" id="mediaInput" accept="image/*" style="margin-top:6px" />

    <div class="buttons">
      <button id="flyHereBtn">Fly here</button>
      <button id="editSiteBtn">Edit</button>
    </div>
    <div class="buttons">
      <button id="deleteSiteBtn">Delete site</button>
    </div>
  `;

  const mediaGrid = document.getElementById("mediaGrid");
  mediaGrid.innerHTML = photos
    .map(
      (r) => `
        <div class="media-thumb" data-filename="${escapeHtml(r.url.split("/").pop())}">
          <img src="${escapeHtml(r.url)}" alt="${escapeHtml(r.title || "")}" />
          <button class="media-remove" title="Remove photo">&times;</button>
        </div>`
    )
    .join("");
  mediaGrid.querySelectorAll(".media-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const filename = btn.parentElement.dataset.filename;
      const updated = await api(`/api/sites/${site.id}/media/${encodeURIComponent(filename)}`, { method: "DELETE" });
      sites = sites.map((s) => (s.id === site.id ? updated : s));
      showDetail(site.id);
    });
  });

  document.getElementById("mediaInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const dataBase64 = dataUrl.split(",")[1];
    const updated = await api(`/api/sites/${site.id}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, dataBase64 }),
    });
    sites = sites.map((s) => (s.id === site.id ? updated : s));
    showDetail(site.id);
  });

  document.getElementById("flyHereBtn").addEventListener("click", () => flyToSite(site));
  document.getElementById("editSiteBtn").addEventListener("click", () => showForm(site));
  document.getElementById("deleteSiteBtn").addEventListener("click", async () => {
    if (!confirm(`Delete "${site.name}"? This also removes its photos.`)) return;
    await api(`/api/sites/${site.id}`, { method: "DELETE" });
    sites = sites.filter((s) => s.id !== site.id);
    renderMarkers();
    populateAreaFilter();
    renderSiteList();
    showListView();
  });

  flyToSite(site);
}

function updateViewSummary() {
  if (!formView) { fViewSummary.textContent = ""; return; }
  fViewSummary.textContent =
    `zoom ${formView.zoom.toFixed(1)}, bearing ${Math.round(formView.bearing)}°, pitch ${Math.round(formView.pitch)}°`;
}

function showForm(site) {
  stopPlacing();
  editingId = site ? site.id : null;
  sitesListView.hidden = true;
  siteDetailView.hidden = true;
  airspaceListView.hidden = true;
  siteForm.hidden = false;
  expandPanel();
  document.getElementById("siteFormTitle").textContent = site ? "Edit site" : "Add site";

  document.getElementById("fName").value = site?.name || "";
  document.getElementById("fArea").value = site?.area || "";
  descriptionEditor.clipboard.dangerouslyPasteHTML(site?.description || "");
  hazardsEditor.clipboard.dangerouslyPasteHTML(site?.hazards || "");
  document.getElementById("fLatitude").value = site?.latitude ?? "";
  document.getElementById("fLongitude").value = site?.longitude ?? "";
  document.getElementById("fElevation").value = site?.elevation_m ?? "";

  formView = site
    ? {
        latitude: site.view_latitude ?? site.latitude,
        longitude: site.view_longitude ?? site.longitude,
        zoom: site.view_zoom ?? map.getZoom(),
        bearing: site.view_bearing ?? 0,
        pitch: site.view_pitch ?? 0,
      }
    : {
        latitude: map.getCenter().lat,
        longitude: map.getCenter().lng,
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };
  updateViewSummary();
}

document.getElementById("useCurrentViewBtn").addEventListener("click", () => {
  formView = {
    latitude: map.getCenter().lat,
    longitude: map.getCenter().lng,
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
  updateViewSummary();
});

document.getElementById("backToListBtn").addEventListener("click", showListView);
document.getElementById("cancelFormBtn").addEventListener("click", () => {
  if (editingId) showDetail(editingId);
  else showListView();
});

siteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById("fName").value.trim(),
    area: document.getElementById("fArea").value.trim(),
    description: descriptionEditor.root.innerHTML,
    hazards: hazardsEditor.root.innerHTML,
    latitude: parseFloat(document.getElementById("fLatitude").value),
    longitude: parseFloat(document.getElementById("fLongitude").value),
    elevation_m: document.getElementById("fElevation").value === "" ? null : parseFloat(document.getElementById("fElevation").value),
    view_latitude: formView.latitude,
    view_longitude: formView.longitude,
    view_zoom: formView.zoom,
    view_bearing: formView.bearing,
    view_pitch: formView.pitch,
  };

  let saved;
  if (editingId) {
    saved = await api(`/api/sites/${editingId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    sites = sites.map((s) => (s.id === saved.id ? saved : s));
  } else {
    saved = await api("/api/sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    sites = [...sites, saved];
  }
  renderMarkers();
  populateAreaFilter();
  renderSiteList();
  showDetail(saved.id);
});

const pickPinBtn = document.getElementById("pickPinBtn");

function startPlacing(mode, bannerText) {
  placingMode = mode;
  placingBanner.textContent = "";
  placingBanner.append(bannerText, " — ");
  const cancelBtn = document.createElement("button");
  cancelBtn.id = "cancelPlacingBtn";
  cancelBtn.textContent = "cancel";
  placingBanner.append(cancelBtn);
  cancelBtn.addEventListener("click", stopPlacing);
  placingBanner.hidden = false;
  map.getCanvas().style.cursor = "crosshair";
  pickPinBtn.classList.toggle("active", mode === "reposition");
}

function stopPlacing() {
  placingMode = null;
  placingBanner.hidden = true;
  map.getCanvas().style.cursor = "";
  pickPinBtn.classList.remove("active");
}

document.getElementById("addSiteBtn").addEventListener("click", () => {
  startPlacing("new", "Click the map to place the new site");
});

pickPinBtn.addEventListener("click", () => {
  if (placingMode === "reposition") {
    stopPlacing();
  } else {
    startPlacing("reposition", "Click the map to set this site's pin");
  }
});

map.on("click", (e) => {
  if (!placingMode) return;
  const mode = placingMode;
  stopPlacing();
  if (mode === "new") {
    showForm(null);
    formView = {
      latitude: map.getCenter().lat,
      longitude: map.getCenter().lng,
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    };
    updateViewSummary();
  }
  document.getElementById("fLatitude").value = e.lngLat.lat.toFixed(6);
  document.getElementById("fLongitude").value = e.lngLat.lng.toFixed(6);
});

map.on("load", loadSites);
