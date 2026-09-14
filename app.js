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

// Dedicated GCP project "xisle-maps" (Map Tiles API + Places API (New)
// enabled, billing linked). The previous shared key (used across
// dem-compare / vancouver-island-3d-map) was revoked/deleted at some point
// -- swap this for your own if it's ever rotated/revoked again.
const GOOGLE_MAPS_API_KEY = "AIzaSyARar1QWsHgRrQLuDllrJ4nDLJBCq6H-SA";

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

// Fetched up front, before the map is created, so the initial camera can
// already be framed around every site. Fetching /api/sites only after the
// map's first "load" (as this used to) meant starting at a fixed, tight
// view, then jumping to the fitted-to-all-sites view a moment later once
// the fetch resolved -- visibly a second, differently-zoomed set of
// terrain/satellite tiles loading right after the first.
let sites = [];
try {
  const res = await fetch("/api/sites");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  sites = await res.json();
} catch (err) {
  console.error("[sites] failed to load /api/sites:", err);
}

// Bounding box (10% buffer, floored so a single site or a tight cluster
// still gets sensible context) around the given sites' coordinates -- used
// both for the initial camera above and whenever the visible set changes
// (search/area filter, see fitToVisibleSites).
function boundsForSites(list) {
  const pinned = list.filter((s) => typeof s.latitude === "number" && typeof s.longitude === "number");
  if (pinned.length === 0) return null;
  const lats = pinned.map((s) => s.latitude);
  const lngs = pinned.map((s) => s.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latBuffer = Math.max((maxLat - minLat) * 0.1, 0.01);
  const lngBuffer = Math.max((maxLng - minLng) * 0.1, 0.01);
  return [
    [minLng - lngBuffer, minLat - latBuffer],
    [maxLng + lngBuffer, maxLat + latBuffer],
  ];
}

// A saved/shared link can specify either a site (?site=<id>, framed the same
// way clicking it in the list would) or a raw camera position (?lng=&lat=&
// zoom=&bearing=&pitch=, written by updateUrl whenever the map moves with no
// site selected) -- either way, resolved before the map is constructed so
// the very first frame is already the right one instead of the default
// fit-to-all-sites view flashing past first.
const urlParams = new URLSearchParams(location.search);
const urlSite = urlParams.has("site") ? sites.find((s) => s.id === urlParams.get("site")) : null;
const urlHasCamera = urlParams.has("lng") && urlParams.has("lat");

const START_BOUNDS = urlSite || urlHasCamera ? null : boundsForSites(sites);
// Fallback center/zoom if /api/sites failed to load or was empty, and
// neither a site nor a camera position came in on the URL.
const START = urlSite
  ? {
      center: [urlSite.view_longitude ?? urlSite.longitude, urlSite.view_latitude ?? urlSite.latitude],
      zoom: urlSite.view_zoom ?? 13,
      bearing: urlSite.view_bearing ?? 0,
      pitch: urlSite.view_pitch ?? 0,
    }
  : urlHasCamera
    ? {
        center: [parseFloat(urlParams.get("lng")), parseFloat(urlParams.get("lat"))],
        zoom: parseFloat(urlParams.get("zoom") ?? "12"),
        bearing: parseFloat(urlParams.get("bearing") ?? "0"),
        pitch: parseFloat(urlParams.get("pitch") ?? "0"),
      }
    : {
        center: [-126.155, 49.365],
        zoom: 12,
        pitch: 0,
        bearing: 0,
      };

// Mirrors the current site (or, with none open, the raw camera position),
// search text, area filter, and airspace toggle into the URL's query string
// via history.replaceState -- called continuously (site selection, filter
// changes, the airspace checkbox, every map moveend) rather than only from
// one specific action, so the address bar is always an accurate "get back
// to exactly this" link, bookmarkable or shareable at any moment without
// the user having to do anything special first.
function updateUrl() {
  const params = new URLSearchParams();
  if (selectedSiteId) {
    params.set("site", selectedSiteId);
  } else {
    const center = map.getCenter();
    params.set("lng", center.lng.toFixed(5));
    params.set("lat", center.lat.toFixed(5));
    params.set("zoom", map.getZoom().toFixed(2));
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    if (bearing) params.set("bearing", bearing.toFixed(1));
    if (pitch) params.set("pitch", pitch.toFixed(1));
  }
  if (siteSearch.value.trim()) params.set("q", siteSearch.value.trim());
  if (areaFilter.value) params.set("area", areaFilter.value);
  if (airspaceToggle.checked) params.set("airspace", "1");
  const qs = params.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

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
const SITE_TRACKS_SOURCE_ID = "site-tracks";
const SITE_TRACKS_CASING_LAYER_ID = "site-tracks-casing";
const SITE_TRACKS_LAYER_ID = "site-tracks-line";
const GLIDE_SOURCE_ID = "glide-range";
const GLIDE_FILL_LAYER_ID = "glide-range-fill";
const GLIDE_LINE_LAYER_ID = "glide-range-line";

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
      // Empty until the airspace checkbox is actually ticked (see
      // ensureAirspaceDataLoaded) -- most visits never turn this on, so
      // there's no reason to fetch and parse it on every page load.
      data: { type: "FeatureCollection", features: [] },
      attribution: '© <a href="https://www.openaip.net" target="_blank" rel="noopener">OpenAIP</a> contributors (CC BY-NC 4.0)',
    },
    [AIRSPACE_HIGHLIGHT_SOURCE_ID]: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    },
    [SITE_TRACKS_SOURCE_ID]: {
      // Populated from the selected site's GPX references (see
      // loadSiteTracks) -- empty while no site is selected or it has none.
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    },
    [GLIDE_SOURCE_ID]: {
      // Populated from computeGlideRange -- empty until the user clicks the
      // map with airspace off. Fill (annulus bands) and outline share this
      // one source, filtered apart by the "kind" property below.
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
    {
      // Dark casing under the track line so it stays legible over bright
      // satellite imagery (snow, sand, pale terrain) as well as dark forest.
      id: SITE_TRACKS_CASING_LAYER_ID,
      type: "line",
      source: SITE_TRACKS_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#000000", "line-width": 10, "line-opacity": 0.4 },
    },
    {
      // Butt caps (not round) so the dashes themselves read as clean dashes
      // rather than a chain of little pills.
      id: SITE_TRACKS_LAYER_ID,
      type: "line",
      source: SITE_TRACKS_SOURCE_ID,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": "#ffcc00", "line-width": 5, "line-dasharray": [2, 2] },
    },
    {
      // Nested 1:1..1:10 glide-reach bands -- see computeGlideRange. Each
      // feature carries its own "color" so the paint expression doesn't need
      // a 10-case match on the ratio property.
      id: GLIDE_FILL_LAYER_ID,
      type: "fill",
      source: GLIDE_SOURCE_ID,
      filter: ["==", ["get", "kind"], "band"],
      paint: { "fill-color": ["get", "color"], "fill-opacity": 0.35 },
    },
    {
      id: GLIDE_LINE_LAYER_ID,
      type: "line",
      source: GLIDE_SOURCE_ID,
      filter: ["==", ["get", "kind"], "ring"],
      paint: { "line-color": ["get", "color"], "line-width": 1.25, "line-opacity": 0.8 },
    },
  ],
};

const map = new Map({
  container: "map",
  style,
  ...(START_BOUNDS ? { bounds: START_BOUNDS } : { center: START.center, zoom: START.zoom }),
  pitch: START.pitch,
  bearing: START.bearing,
  attributionControl: false,
});

window.map = map;

// Keeps the URL's camera params current whenever the user pans/zooms/tilts
// freely (updateUrl itself skips this in favor of ?site= while a site is
// open -- see selectedSiteId).
map.on("moveend", updateUrl);

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

let airspaceDataRequested = false;

// Fetches the airspace geojson into its (initially empty) source the first
// time it's actually needed, instead of every page load regardless of
// whether the checkbox ever gets ticked.
function ensureAirspaceDataLoaded() {
  if (airspaceDataRequested) return;
  airspaceDataRequested = true;
  fetch(`${window.location.origin}/data/airspace.geojson`)
    .then((res) => res.json())
    .then((geojson) => map.getSource(AIRSPACE_SOURCE_ID)?.setData(geojson))
    .catch((err) => {
      airspaceDataRequested = false;
      console.error("[airspace] failed to load data/airspace.geojson:", err);
    });
}

function applyAirspaceVisibility() {
  const visibility = airspaceToggle.checked ? "visible" : "none";
  map.setLayoutProperty(AIRSPACE_FILL_LAYER_ID, "visibility", visibility);
  map.setLayoutProperty(AIRSPACE_LINE_LAYER_ID, "visibility", visibility);
  airspaceLegend.classList.toggle("airspace-legend-disabled", !airspaceToggle.checked);
  if (airspaceToggle.checked) {
    ensureAirspaceDataLoaded();
    clearGlideRange(); // the two overlays would just fight for the same pixels
  }
  updateUrl();
}

map.on("load", () => {
  applyAirspaceFilter();
  applyAirspaceVisibility();
});
airspaceToggle.addEventListener("change", applyAirspaceVisibility);
airspaceClassCheckboxes.forEach((cb) => cb.addEventListener("change", applyAirspaceFilter));

// --- Glide range tool ---
//
// A plain map click, while not placing a site pin and with airspace
// switched off, draws nested 1:1..1:10 glide-reach bands around the click
// point: for each ratio, how far a pilot starting right at that point's own
// ground elevation (0m AGL -- e.g. launching off a ridge or cliff) could
// glide before the descending glide slope meets rising terrain in that
// direction. Ratio 1 (steepest) is the innermost band, ratio 10
// (shallowest, furthest-reaching) the outermost.
//
// Terrain is sampled from the raw Terrarium DEM tiles directly (same
// dataset as the hillshade/terrain sources above) rather than through
// map.queryTerrainElevation, which only answers for tiles MapLibre has
// already decoded for the current view -- a glide fan routinely reaches
// well beyond the visible viewport.

const ELEV_TILE_ZOOM = 12; // ~25m/px at this latitude -- plenty for a glide-planning aid
// globalThis.Map, not the MapLibre Map class imported (shadowed) above.
const elevTilePromises = new globalThis.Map(); // "z/x/y" -> Promise<ImageData | null>, for de-duping fetches
const elevTileData = new globalThis.Map(); // "z/x/y" -> ImageData | null, set once that promise resolves

function lngLatToTileXY(lng, lat, z) {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return [x, y];
}

function fetchElevTile(z, x, y) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, img.width, img.height));
      } catch {
        resolve(null); // tainted canvas -- treat as "no data" rather than throw
      }
    };
    img.onerror = () => resolve(null);
    img.src = `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;
  });
}

function getElevTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let promise = elevTilePromises.get(key);
  if (!promise) {
    promise = fetchElevTile(z, x, y).then((data) => {
      elevTileData.set(key, data);
      return data;
    });
    elevTilePromises.set(key, promise);
  }
  return promise;
}

// Fetches every DEM tile covering the given lng/lat box (skipping ones
// already cached) and resolves once they're all in.
async function prefetchElevTiles(lngMin, lngMax, latMin, latMax) {
  const [x0, y0] = lngLatToTileXY(lngMin, latMax, ELEV_TILE_ZOOM); // NW corner
  const [x1, y1] = lngLatToTileXY(lngMax, latMin, ELEV_TILE_ZOOM); // SE corner
  const jobs = [];
  for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
    for (let y = Math.floor(y0); y <= Math.floor(y1); y++) jobs.push(getElevTile(ELEV_TILE_ZOOM, x, y));
  }
  await Promise.all(jobs);
}

// Synchronous once the relevant tiles are cached (see prefetchElevTiles).
// Nearest-pixel lookup -- fine at this resolution for a planning overlay.
function sampleElevation(lng, lat) {
  const [xf, yf] = lngLatToTileXY(lng, lat, ELEV_TILE_ZOOM);
  const x = Math.floor(xf), y = Math.floor(yf);
  const data = elevTileData.get(`${ELEV_TILE_ZOOM}/${x}/${y}`);
  if (!data) return null;
  const px = Math.min(data.width - 1, Math.max(0, Math.floor((xf - x) * data.width)));
  const py = Math.min(data.height - 1, Math.max(0, Math.floor((yf - y) * data.height)));
  const idx = (py * data.width + px) * 4;
  return data.data[idx] * 256 + data.data[idx + 1] + data.data[idx + 2] / 256 - 32768;
}

const EARTH_RADIUS_M = 6371000;

// Great-circle destination point, given a start, bearing, and distance.
function destinationPoint(lng, lat, bearingDeg, distanceM) {
  const angDist = distanceM / EARTH_RADIUS_M;
  const bearing = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lng * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(angDist) + Math.cos(φ1) * Math.sin(angDist) * Math.cos(bearing));
  const λ2 = λ1 + Math.atan2(Math.sin(bearing) * Math.sin(angDist) * Math.cos(φ1), Math.cos(angDist) - Math.sin(φ1) * Math.sin(φ2));
  return [((λ2 * 180) / Math.PI + 540) % 360 - 180, (φ2 * 180) / Math.PI];
}

function haversineDistance(lng1, lat1, lng2, lat2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function ringSignedArea(coords) {
  let sum = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

// GeoJSON wants exterior rings counter-clockwise and holes clockwise.
function orientRing(coords, ccw) {
  return ringSignedArea(coords) > 0 === ccw ? coords : [...coords].reverse();
}

const GLIDE_RATIOS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // steepest (smallest reach) first
const GLIDE_RAY_COUNT = 72; // every 5°
const GLIDE_STEP_M = 100; // coarse scan step -- see GLIDE_REFINE_ITERS for the actual boundary precision
const GLIDE_REFINE_ITERS = 6; // bisection steps once a ray's coarse scan finds the bracket it grounds out in -- ~1.6m precision at a 100m step
const GLIDE_MIN_RADIUS_M = 3000;
const GLIDE_MAX_RADIUS_M = 25000;

function glideColor(ratio) {
  const t = (ratio - 1) / 9; // 0 (1:1, steepest) .. 1 (1:10, shallowest)
  // Full red -> violet sweep (ROYGBIV) rather than just red -> green, so all
  // 10 bands stay visually distinct instead of bunching up in one corner of
  // the hue wheel.
  return `hsl(${Math.round(t * 270)}, 85%, 50%)`;
}

const glideLegend = document.getElementById("glideLegend");
let glideRequestToken = 0;
let glideOrigin = null; // { lng, lat, elev } for the currently shown fan, or null

// The ratio a pilot starting at glideOrigin (0m AGL there) would need in
// order to reach (lng,lat) in a straight line without ever dipping under
// intervening terrain -- i.e. exactly the shallowest band that point would
// fall inside, but computed continuously for wherever the cursor actually
// is instead of snapping to one of the 10 rendered bands. Returns null if
// there's no fan yet, the point is too close to the origin to say anything
// meaningful, or terrain data isn't cached that far out; Infinity if terrain
// clearly above launch height blocks the path outright.
const GLIDE_HOVER_SAMPLES = 40;
// The DEM is ~25-30m/px (see ELEV_TILE_ZOOM) and sampled nearest-pixel, so a
// hover point within a pixel or two of the origin often lands on the exact
// same pixel as the origin's own elevation sample -- a height difference of
// precisely 0, not a real obstacle. Below this distance there's nothing
// meaningful to report; above it, this much tolerance keeps that same
// quantization noise from reporting a *closer* point as impossible right
// next to a *farther* one that reads as perfectly reachable.
const GLIDE_HOVER_MIN_DIST_M = 30;
const GLIDE_ELEV_NOISE_M = 5;
function requiredGlideRatio(lng, lat) {
  if (!glideOrigin) return null;
  const dist = haversineDistance(glideOrigin.lng, glideOrigin.lat, lng, lat);
  if (dist < GLIDE_HOVER_MIN_DIST_M) return null;
  let maxRatio = 0;
  for (let i = 1; i <= GLIDE_HOVER_SAMPLES; i++) {
    const t = i / GLIDE_HOVER_SAMPLES;
    const plng = glideOrigin.lng + (lng - glideOrigin.lng) * t;
    const plat = glideOrigin.lat + (lat - glideOrigin.lat) * t;
    const elev = sampleElevation(plng, plat);
    if (elev == null) return null;
    const headroom = glideOrigin.elev - elev;
    if (headroom <= -GLIDE_ELEV_NOISE_M) return Infinity; // genuinely higher terrain -- no finite ratio clears it
    maxRatio = Math.max(maxRatio, (dist * t) / Math.max(headroom, GLIDE_ELEV_NOISE_M));
  }
  return maxRatio;
}

function clearGlideRange() {
  glideRequestToken++; // discards the result of any computation still in flight
  glideOrigin = null;
  map.getSource(GLIDE_SOURCE_ID)?.setData({ type: "FeatureCollection", features: [] });
  glideLegend.hidden = true;
  glideLegend.innerHTML = "";
  glideHoverTip.hidden = true;
}

function renderGlideLegend(originElevM) {
  glideLegend.innerHTML = "";
  const title = document.createElement("div");
  title.className = "glide-legend-title";
  title.textContent = `Glide reach from ${Math.round(originElevM)} m`;
  const rows = document.createElement("div");
  rows.className = "glide-legend-rows";
  // Shallowest (furthest-reaching, outermost band) listed first.
  for (const ratio of [...GLIDE_RATIOS].reverse()) {
    const row = document.createElement("div");
    row.className = "glide-legend-row";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = glideColor(ratio);
    row.append(swatch, document.createTextNode(`1:${ratio}`));
    rows.append(row);
  }
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", clearGlideRange);
  glideLegend.append(title, rows, clearBtn);
  glideLegend.hidden = false;
}

function showGlideError(message) {
  glideLegend.innerHTML = "";
  const text = document.createElement("div");
  text.className = "glide-legend-title";
  text.textContent = message;
  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.textContent = "Dismiss";
  dismissBtn.addEventListener("click", clearGlideRange);
  glideLegend.append(text, dismissBtn);
  glideLegend.hidden = false;
}

async function computeGlideRange(lng, lat) {
  const token = ++glideRequestToken;
  map.getCanvas().style.cursor = "wait";
  try {
    await prefetchElevTiles(lng, lng, lat, lat);
    if (token !== glideRequestToken) return;
    const originElev = sampleElevation(lng, lat);
    if (originElev == null) {
      showGlideError("No terrain data at that point.");
      return;
    }

    const maxRadius = Math.min(GLIDE_MAX_RADIUS_M, Math.max(GLIDE_MIN_RADIUS_M, originElev * 10));
    const dLat = maxRadius / 111320;
    const dLng = maxRadius / (111320 * Math.cos((lat * Math.PI) / 180));
    await prefetchElevTiles(lng - dLng, lng + dLng, lat - dLat, lat + dLat);
    if (token !== glideRequestToken) return;

    // boundary[ratio][i] = reachable distance (m) along ray i, for that ratio.
    const boundary = Object.fromEntries(GLIDE_RATIOS.map((r) => [r, new Array(GLIDE_RAY_COUNT).fill(maxRadius)]));

    for (let i = 0; i < GLIDE_RAY_COUNT; i++) {
      const bearing = (360 / GLIDE_RAY_COUNT) * i;
      const unresolved = new Set(GLIDE_RATIOS);
      let lastSafeD = 0; // the most recent distance every still-unresolved ratio was confirmed clear at
      for (let d = GLIDE_STEP_M; d <= maxRadius && unresolved.size > 0; d += GLIDE_STEP_M) {
        const [plng, plat] = destinationPoint(lng, lat, bearing, d);
        const elev = sampleElevation(plng, plat);
        if (elev == null) {
          // Edge of the prefetched box -- stop here rather than assume open
          // air beyond it (shouldn't normally happen; the box is sized with
          // margin for exactly this radius).
          for (const r of unresolved) boundary[r][i] = lastSafeD;
          break;
        }
        for (const r of [...unresolved]) {
          if (elev >= originElev - d / r) {
            // Ground was hit somewhere between lastSafeD (still clear) and d
            // (already grounded) -- bisect that bracket instead of just
            // reporting d, which would otherwise round every ratio up to the
            // same coarse step size. That's glaring for steep ratios: a 1:1
            // glide loses GLIDE_STEP_M of altitude within GLIDE_STEP_M of
            // travel, so it grounds out on the very first sample in nearly
            // every direction, and without refinement every ray reports
            // exactly the same "distance" -- a perfect circle that reflects
            // the sampling grid, not the terrain.
            let lo = lastSafeD;
            let hi = d;
            for (let k = 0; k < GLIDE_REFINE_ITERS; k++) {
              const mid = (lo + hi) / 2;
              const [mlng, mlat] = destinationPoint(lng, lat, bearing, mid);
              const mElev = sampleElevation(mlng, mlat);
              if (mElev == null || mElev >= originElev - mid / r) hi = mid;
              else lo = mid;
            }
            boundary[r][i] = hi;
            unresolved.delete(r);
          }
        }
        lastSafeD = d;
      }
    }

    if (token !== glideRequestToken) return;

    const rings = {};
    for (const r of GLIDE_RATIOS) {
      const pts = boundary[r].map((dist, i) => destinationPoint(lng, lat, (360 / GLIDE_RAY_COUNT) * i, dist));
      pts.push(pts[0]);
      rings[r] = pts;
    }

    const features = [];
    let prevRing = null;
    for (const r of GLIDE_RATIOS) {
      const color = glideColor(r);
      const outer = orientRing(rings[r], true);
      const coordinates = prevRing ? [outer, orientRing(prevRing, false)] : [outer];
      features.push({ type: "Feature", properties: { kind: "band", ratio: r, color }, geometry: { type: "Polygon", coordinates } });
      features.push({ type: "Feature", properties: { kind: "ring", ratio: r, color }, geometry: { type: "LineString", coordinates: rings[r] } });
      prevRing = rings[r];
    }

    map.getSource(GLIDE_SOURCE_ID)?.setData({ type: "FeatureCollection", features });
    glideOrigin = { lng, lat, elev: originElev };
    renderGlideLegend(originElev);
  } catch (err) {
    console.error("[glide] failed to compute glide range:", err);
    if (token === glideRequestToken) showGlideError("Couldn't compute glide range.");
  } finally {
    if (token === glideRequestToken) map.getCanvas().style.cursor = "";
  }
}

const glideHoverTip = document.getElementById("glideHoverTip");
map.on("mousemove", (e) => {
  const ratio = requiredGlideRatio(e.lngLat.lng, e.lngLat.lat);
  if (ratio == null) {
    glideHoverTip.hidden = true;
    return;
  }
  glideHoverTip.textContent = ratio === Infinity ? "unreachable" : `1:${ratio.toFixed(2)}`;
  glideHoverTip.style.left = `${e.point.x + 14}px`;
  glideHoverTip.style.top = `${e.point.y + 14}px`;
  glideHoverTip.hidden = false;
});
map.on("mouseout", () => {
  glideHoverTip.hidden = true;
});

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
document.getElementById("airspaceBackBtn").addEventListener("click", () => {
  pinAirspaceRow(null);
  showListView();
});

// The row currently pinned by a click, if any -- kept highlighted (and
// re-highlighted after a hover elsewhere ends) so it survives map
// panning/rotating instead of only showing while the pointer sits on the
// row. { row, entry } or null.
let pinnedAirspaceRow = null;

function pinAirspaceRow(row, entry) {
  if (pinnedAirspaceRow) pinnedAirspaceRow.row.classList.remove("airspace-pinned");
  if (row && pinnedAirspaceRow && pinnedAirspaceRow.row === row) {
    // Clicking the already-pinned row again unpins it.
    pinnedAirspaceRow = null;
    setAirspaceHighlight(null);
    return;
  }
  pinnedAirspaceRow = row ? { row, entry } : null;
  if (pinnedAirspaceRow) {
    row.classList.add("airspace-pinned");
    setAirspaceHighlight(entry.geometry, entry.properties);
  } else {
    setAirspaceHighlight(null);
  }
}

// FIRs share the "SUA" class label with restricted/danger areas (see
// classLabel in tools/fetchairspace), so they can't be told apart by class
// -- only by name -- and their SFC-FL999 span would otherwise sort them
// wherever their (effectively arbitrary) ceiling lands instead of always
// last, where their sheer size makes them the least specific answer.
function isFir(entry) {
  return /\bFIR\b/i.test(entry.properties.name);
}

function sortAirspaceEntries(entries) {
  return [...entries].sort((a, b) => {
    const aFir = isFir(a);
    const bFir = isFir(b);
    if (aFir !== bFir) return aFir ? 1 : -1;
    return (a.properties.ceilingM ?? Infinity) - (b.properties.ceilingM ?? Infinity);
  });
}

function showAirspaceList(entries) {
  stopPlacing();
  sitesListView.hidden = true;
  siteDetailView.hidden = true;
  siteForm.hidden = true;
  airspaceListView.hidden = false;
  expandPanel();

  // A fresh click query supersedes whatever was pinned from the previous
  // one -- otherwise its highlight/volume would keep showing for a shape
  // that's no longer in the list.
  pinnedAirspaceRow = null;
  setAirspaceHighlight(null);
  airspaceEntries.innerHTML = "";
  const sorted = sortAirspaceEntries(entries);
  let firstRow = null;
  sorted.forEach((entry, index) => {
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
    row.addEventListener("mouseleave", () => {
      if (pinnedAirspaceRow) setAirspaceHighlight(pinnedAirspaceRow.entry.geometry, pinnedAirspaceRow.entry.properties);
      else setAirspaceHighlight(null);
    });
    row.addEventListener("click", () => pinAirspaceRow(row, entry));
    airspaceEntries.appendChild(row);
    if (index === 0) firstRow = row;
  });
  // Land straight on the lowest (most relevant) entry's highlight instead
  // of making the user hover or click it themselves.
  if (firstRow) pinAirspaceRow(firstRow, sorted[0]);
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

// --- Header place search: Places API (New) autocomplete + place details,
// reusing the same API key as the gtiles:// satellite session above. This
// key needs Places API (New) enabled in the Google Cloud project it belongs
// to -- it's a separate API from the Map Tiles one already in use here. ---

const placeSearchInput = document.getElementById("placeSearch");
const placeSuggestionsEl = document.getElementById("placeSuggestions");

let placeSearchDebounce = null;
let placeSearchToken = 0; // discards a stale response if a newer query has since been issued
let placePredictions = [];
let placeActiveIndex = -1;

function hidePlaceSuggestions() {
  placeSuggestionsEl.hidden = true;
  placeSuggestionsEl.innerHTML = "";
  placePredictions = [];
  placeActiveIndex = -1;
}

function renderPlaceSuggestions() {
  placeSuggestionsEl.innerHTML = placePredictions
    .map((p, i) => `<div class="place-suggestion${i === placeActiveIndex ? " active" : ""}" data-index="${i}">${escapeHtml(p.text?.text || "")}</div>`)
    .join("");
  placeSuggestionsEl.hidden = placePredictions.length === 0;
  placeSuggestionsEl.querySelectorAll(".place-suggestion").forEach((el) => {
    el.addEventListener("click", () => selectPlace(placePredictions[Number(el.dataset.index)]));
  });
}

async function runPlaceAutocomplete(query) {
  const token = ++placeSearchToken;
  const center = map.getCenter();
  let suggestions = [];
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY },
      // Bias (not restrict) toward the current map view -- lets a search
      // for a place outside Vancouver Island still find its way there.
      body: JSON.stringify({
        input: query,
        // 50,000m is the API's max radius for a circle bias.
        locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: 50000 } },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      suggestions = data.suggestions || [];
    }
  } catch {
    suggestions = [];
  }
  if (token !== placeSearchToken) return; // a newer keystroke has already superseded this
  placePredictions = suggestions.map((s) => s.placePrediction).filter(Boolean);
  placeActiveIndex = -1;
  renderPlaceSuggestions();
}

async function selectPlace(prediction) {
  if (!prediction) return;
  placeSearchInput.value = prediction.text?.text || "";
  hidePlaceSuggestions();
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${prediction.placeId}?fields=location,viewport`, {
      headers: { "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY },
    });
    if (!res.ok) return;
    const place = await res.json();
    if (place.viewport) {
      const v = place.viewport;
      map.fitBounds([[v.low.longitude, v.low.latitude], [v.high.longitude, v.high.latitude]], { padding: 40, duration: 1500 });
    } else if (place.location) {
      map.flyTo({ center: [place.location.longitude, place.location.latitude], zoom: 13, duration: 1500 });
    }
  } catch {
    // A failed lookup just leaves the map where it was -- nothing to recover.
  }
}

placeSearchInput.addEventListener("input", () => {
  const query = placeSearchInput.value.trim();
  clearTimeout(placeSearchDebounce);
  if (!query) {
    hidePlaceSuggestions();
    return;
  }
  placeSearchDebounce = setTimeout(() => runPlaceAutocomplete(query), 250);
});

placeSearchInput.addEventListener("keydown", (e) => {
  if (placePredictions.length === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    placeActiveIndex = (placeActiveIndex + 1) % placePredictions.length;
    renderPlaceSuggestions();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    placeActiveIndex = (placeActiveIndex - 1 + placePredictions.length) % placePredictions.length;
    renderPlaceSuggestions();
  } else if (e.key === "Enter") {
    e.preventDefault();
    selectPlace(placePredictions[placeActiveIndex] ?? placePredictions[0]);
  } else if (e.key === "Escape") {
    hidePlaceSuggestions();
  }
});

document.addEventListener("click", (e) => {
  if (!placeSuggestionsEl.hidden && !e.target.closest(".topbar-search")) hidePlaceSuggestions();
});

// --- Sites: markers + CRUD against the local /api/sites backend (data
// already fetched above, before the map was created) ---

const markersById = {};
const labelMarkersById = {};
// null while inactive; "new" while placing a brand-new site (from the list's
// "+ Add" button, before any form is open); "reposition" while updating the
// pin of whichever form (add or edit) is currently open.
let placingMode = null;
let editingId = null; // null while adding a new site
let selectedSiteId = null; // the site currently open in the read-only detail view, if any -- drives the ?site= URL param
let formView = null; // {latitude, longitude, zoom, bearing, pitch} camera preset for the form in progress
let formSite = null; // site object backing the open form's media list; null until the site exists (saved at least once)

const sitesListView = document.getElementById("sitesListView");
const siteDetailView = document.getElementById("siteDetailView");
const siteForm = document.getElementById("siteForm");
const siteList = document.getElementById("siteList");
const siteSearch = document.getElementById("siteSearch");
const areaFilter = document.getElementById("areaFilter");
const siteDetailContent = document.getElementById("siteDetailContent");
const placingBanner = document.getElementById("placingBanner");
const fViewSummary = document.getElementById("fViewSummary");
const mediaList = document.getElementById("mediaList");
const mediaInput = document.getElementById("mediaInput");
const mediaHint = document.getElementById("mediaHint");

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

// Shared rendering for a site's media (references with type photo/pdf/gpx):
// a photo renders as an actual thumbnail, everything else as a short kind
// label (PDF/GPX) since there's no useful thumbnail to show.
function mediaKindLabel(type) {
  return type === "pdf" ? "PDF" : type === "gpx" ? "GPX" : "FILE";
}

// Read-only photo thumbnail, linking out to the full image.
function mediaThumbHtml(r) {
  return `
    <a class="media-thumb" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">
      <img src="${escapeHtml(r.url)}" alt="${escapeHtml(r.description || r.title || "")}" />
    </a>`;
}

// Read-only PDF/GPX row: a named link plus its description. GPX tracks
// download (viewing raw XML inline isn't useful); PDFs open in a new tab.
function mediaFileRowHtml(r) {
  const filename = r.url.split("/").pop();
  return `
    <a class="media-file-row" href="${escapeHtml(r.url)}" target="_blank" rel="noopener"${r.type === "gpx" ? " download" : ""}>
      <span class="media-file-kind">${mediaKindLabel(r.type)}</span>
      <span class="media-file-title">${escapeHtml(r.title || filename)}</span>
      ${r.description ? `<span class="media-file-desc">${escapeHtml(r.description)}</span>` : ""}
    </a>`;
}

// Pulls track (or, failing that, route) point sequences out of a GPX file's
// XML -- just the lon/lat pairs needed to draw a line, nothing else in the
// schema (elevation, time, waypoints) is used anywhere in this app.
function parseGpxLineStrings(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) return [];
  const coordsOf = (el, pointTag) =>
    [...el.querySelectorAll(pointTag)]
      .map((pt) => [parseFloat(pt.getAttribute("lon")), parseFloat(pt.getAttribute("lat"))])
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  let segments = [...doc.querySelectorAll("trkseg")].map((seg) => coordsOf(seg, "trkpt")).filter((c) => c.length >= 2);
  if (segments.length === 0) {
    segments = [...doc.querySelectorAll("rte")].map((rte) => coordsOf(rte, "rtept")).filter((c) => c.length >= 2);
  }
  return segments.map((coordinates) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }));
}

function setSiteTracks(features) {
  const source = map.getSource(SITE_TRACKS_SOURCE_ID);
  if (source) source.setData({ type: "FeatureCollection", features });
}

// Fetches and draws every GPX reference on the given site as map lines.
// Fire-and-forget from showDetail -- a slow/failed fetch just means the
// track appears late or not at all, not worth blocking the detail view for.
async function loadSiteTracks(site) {
  const gpxRefs = (site.references || []).filter((r) => r.type === "gpx");
  if (gpxRefs.length === 0) {
    setSiteTracks([]);
    return;
  }
  const perFile = await Promise.all(
    gpxRefs.map(async (r) => {
      try {
        const res = await fetch(r.url);
        return res.ok ? parseGpxLineStrings(await res.text()) : [];
      } catch {
        return [];
      }
    })
  );
  setSiteTracks(perFile.flat());
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
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
  const bounds = boundsForSites(getFilteredSites());
  if (bounds) map.fitBounds(bounds, { duration: 0 });
}

function renderMarkers() {
  for (const id in markersById) markersById[id].remove();
  for (const id in markersById) delete markersById[id];
  for (const id in labelMarkersById) labelMarkersById[id].remove();
  for (const id in labelMarkersById) delete labelMarkersById[id];
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

    // A second, independent marker just for the name text, anchored to the
    // same point -- kept completely separate from the pin marker above so
    // labeling can't affect the pin's own element/sizing/positioning.
    const labelEl = document.createElement("div");
    labelEl.className = "site-marker-label";
    labelEl.textContent = site.name;
    // Without this, a click landing on the label text (rather than the pin
    // icon itself) falls straight through to the map underneath -- opening
    // nothing, and, with airspace off, firing the glide range tool instead.
    labelEl.addEventListener("click", (e) => {
      e.stopPropagation();
      showDetail(site.id);
    });
    const labelMarker = new Marker({ element: labelEl, anchor: "left", offset: [10, 0] })
      .setLngLat([site.longitude, site.latitude])
      .addTo(map);
    labelMarkersById[site.id] = labelMarker;
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
  updateUrl();
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
  setSiteTracks([]);
  selectedSiteId = null;
  updateUrl();
}

function showDetail(id) {
  stopPlacing();
  const site = sites.find((s) => s.id === id);
  if (!site) return;
  selectedSiteId = id;
  sitesListView.hidden = true;
  siteForm.hidden = true;
  airspaceListView.hidden = true;
  siteDetailView.hidden = false;
  expandPanel();
  setSiteTracks([]);
  loadSiteTracks(site);

  const photos = (site.references || []).filter((r) => r.type === "photo");
  const files = (site.references || []).filter((r) => r.type === "pdf" || r.type === "gpx");
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

    ${photos.length ? `<div class="section-label">Photos</div><div class="media-grid">${photos.map(mediaThumbHtml).join("")}</div>` : ""}
    ${files.length ? `<div class="section-label">Files</div><div class="media-file-list">${files.map(mediaFileRowHtml).join("")}</div>` : ""}

    <div class="buttons">
      <button id="flyHereBtn">Fly here</button>
      <button id="editSiteBtn">Edit</button>
    </div>
    <div class="buttons">
      <button id="deleteSiteBtn">Delete site</button>
    </div>
  `;

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
  updateUrl();
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

  formSite = site || null;
  renderMediaList();

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

function mediaTypeFromFilename(filename) {
  switch ((filename.split(".").pop() || "").toLowerCase()) {
    case "png": case "jpg": case "jpeg": case "gif": return "photo";
    case "pdf": return "pdf";
    case "gpx": return "gpx";
    default: return null;
  }
}

// Editable media list for the form in progress: each row shows a thumbnail
// (photos) or kind label (PDF/GPX), a filename, and a description input
// that saves on blur/change -- disabled until the site has been saved at
// least once, since a photo/file needs a site id to upload under.
function renderMediaList() {
  const media = formSite ? (formSite.references || []).filter((r) => r.type === "photo" || r.type === "pdf" || r.type === "gpx") : [];
  mediaList.innerHTML = media
    .map((r) => {
      const filename = r.url.split("/").pop();
      const thumb = r.type === "photo"
        ? `<img src="${escapeHtml(r.url)}" alt="" />`
        : mediaKindLabel(r.type);
      return `
        <div class="media-row" data-filename="${escapeHtml(filename)}">
          <div class="media-row-thumb">${thumb}</div>
          <div class="media-row-body">
            <div class="media-row-title">${escapeHtml(r.title || filename)}</div>
            <input type="text" class="media-desc-input" placeholder="Description..." value="${escapeHtml(r.description || "")}" />
          </div>
          <button type="button" class="media-row-remove" title="Remove">&times;</button>
        </div>`;
    })
    .join("");
  mediaHint.hidden = !!formSite;
  mediaInput.disabled = !formSite;
}

mediaInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !formSite) return;
  if (!mediaTypeFromFilename(file.name)) {
    alert("Unsupported file type. Use PNG, JPG, PDF, or GPX.");
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const dataBase64 = dataUrl.split(",")[1];
  const updated = await api(`/api/sites/${formSite.id}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, dataBase64, description: "" }),
  });
  formSite = updated;
  sites = sites.map((s) => (s.id === updated.id ? updated : s));
  renderMediaList();
});

mediaList.addEventListener("change", async (e) => {
  if (!e.target.matches(".media-desc-input") || !formSite) return;
  const filename = e.target.closest(".media-row").dataset.filename;
  const updated = await api(`/api/sites/${formSite.id}/media/${encodeURIComponent(filename)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: e.target.value }),
  });
  formSite = updated;
  sites = sites.map((s) => (s.id === updated.id ? updated : s));
});

mediaList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".media-row-remove");
  if (!btn || !formSite) return;
  const filename = btn.closest(".media-row").dataset.filename;
  const updated = await api(`/api/sites/${formSite.id}/media/${encodeURIComponent(filename)}`, { method: "DELETE" });
  formSite = updated;
  sites = sites.map((s) => (s.id === updated.id ? updated : s));
  renderMediaList();
});

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
  if (!placingMode) {
    if (!airspaceToggle.checked) computeGlideRange(e.lngLat.lng, e.lngLat.lat);
    return;
  }
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

// Applies whatever came in on the URL (see urlParams/urlSite near the top)
// on top of the normal initial render: search text and area filter need to
// land before the first renderMarkers/renderSiteList so they're not shown
// only to immediately re-render a moment later. The camera itself was
// already handled before the map was even constructed (see START), so
// there's nothing to do for it here.
//
// Deliberately NOT gated on the map's "load" event: renderMarkers/
// renderSiteList are plain DOM + MapLibre Marker calls that work on a
// freshly-constructed Map regardless of whether its style/tiles have
// finished loading, and gating the site list on "load" meant a slow or
// failed basemap (e.g. a rejected/rate-limited satellite tile session)
// left the sidebar empty even though the site data itself had already
// loaded fine.
function applyInitialUrlState() {
  populateAreaFilter();
  if (urlParams.has("q")) siteSearch.value = urlParams.get("q");
  if (urlParams.has("area")) areaFilter.value = urlParams.get("area");
  renderMarkers();
  renderSiteList();
}
applyInitialUrlState();

// These two genuinely need the style's layers/sources to exist, so they
// stay gated on "load".
map.on("load", () => {
  if (urlParams.get("airspace") === "1") {
    airspaceToggle.checked = true;
    applyAirspaceVisibility();
  }
  if (urlSite) showDetail(urlSite.id);
});
