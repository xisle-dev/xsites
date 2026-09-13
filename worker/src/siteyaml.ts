// Purpose-built YAML read/write for the site schema -- not a general YAML
// parser. Ported line-for-line from server/siteyaml.go (Go), which itself
// documents: every site record is a flat set of known scalar keys plus one
// "references" list of {type,title,description,url} maps, so a
// line-oriented reader/writer is enough and keeps this dependency-free.
//
// Byte-for-byte compatible with the Go version by construction -- this is
// a straight port, not a reinterpretation. See github issue #13.

export interface Reference {
  type: string;
  title: string;
  description: string;
  url: string;
}

export interface Site {
  id: string;
  name: string;
  area: string;
  description: string;
  hazards: string;
  latitude: number;
  longitude: number;
  elevation_m?: number | null;
  view_latitude: number;
  view_longitude: number;
  view_zoom: number;
  view_bearing?: number | null;
  view_pitch: number;
  references: Reference[];
}

// SiteInput mirrors Site but every field is optional, so a PUT/POST body
// can distinguish "field omitted" (leave existing value alone) from
// "field explicitly set" -- same semantics as Go's SiteInput pointer
// fields. Both "key absent" and "key: null" mean "omitted" (checked with
// == null below), matching how Go's JSON decoder treats a missing key and
// an explicit null identically for a pointer field.
export interface SiteInput {
  name?: string | null;
  area?: string | null;
  description?: string | null;
  hazards?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  elevation_m?: number | null;
  view_latitude?: number | null;
  view_longitude?: number | null;
  view_zoom?: number | null;
  view_bearing?: number | null;
  view_pitch?: number | null;
  references?: Reference[] | null;
}

export function applySiteInput(site: Site, input: SiteInput): void {
  if (input.name != null) site.name = input.name;
  if (input.area != null) site.area = input.area;
  if (input.description != null) site.description = input.description;
  if (input.hazards != null) site.hazards = input.hazards;
  if (input.latitude != null) site.latitude = input.latitude;
  if (input.longitude != null) site.longitude = input.longitude;
  if (input.elevation_m != null) site.elevation_m = input.elevation_m;
  if (input.view_latitude != null) site.view_latitude = input.view_latitude;
  if (input.view_longitude != null) site.view_longitude = input.view_longitude;
  if (input.view_zoom != null) site.view_zoom = input.view_zoom;
  if (input.view_bearing != null) site.view_bearing = input.view_bearing;
  if (input.view_pitch != null) site.view_pitch = input.view_pitch;
  if (input.references != null) site.references = input.references;
}

const topLineRe = /^([A-Za-z_]+):\s?(.*)$/;
const refItemRe = /^\s*-\s*([A-Za-z_]+):\s?(.*)$/;
const refFieldRe = /^\s+([A-Za-z_]+):\s?(.*)$/;

// Go's strings.Trim(s, `"`) strips a whole run of the cutset characters
// from both ends, not just one -- replicate that exactly (a naive
// single-character trim would leave a stray quote on a doubled-up edge
// case).
function trimQuotes(s: string): string {
  return s.replace(/^"+/, "").replace(/"+$/, "");
}

function parseFloatOrUndefined(s: string): number | undefined {
  const f = Number.parseFloat(s);
  return Number.isNaN(f) ? undefined : f;
}

// The read side: parses raw YAML bytes (as produced by renderSiteYaml)
// into a Site. Mirrors parseSiteYaml in server/siteyaml.go exactly,
// including its lenient behavior -- unparseable numeric fields are simply
// left at their zero value rather than raising an error.
export function parseSiteYaml(data: string, id: string): Site {
  const site: Site = {
    id,
    name: "",
    area: "",
    description: "",
    hazards: "",
    latitude: 0,
    longitude: 0,
    view_latitude: 0,
    view_longitude: 0,
    view_zoom: 0,
    view_pitch: 0,
    references: [],
  };

  const lines = data.split("\n");
  let mode: "top" | "refs" = "top";
  let current: Partial<Reference> | null = null;

  const flush = () => {
    if (current != null) {
      site.references.push({
        type: current.type ?? "",
        title: current.title ?? "",
        description: current.description ?? "",
        url: current.url ?? "",
      });
      current = null;
    }
  };

  const setRefField = (r: Partial<Reference>, key: string, val: string) => {
    switch (key) {
      case "type":
        r.type = val;
        break;
      case "title":
        r.title = val;
        break;
      case "description":
        r.description = val;
        break;
      case "url":
        r.url = val;
        break;
    }
  };

  const setTopField = (key: string, val: string) => {
    switch (key) {
      case "name":
        site.name = val;
        break;
      case "area":
        site.area = val;
        break;
      case "description":
        site.description = val;
        break;
      case "hazards":
        site.hazards = val;
        break;
      case "latitude":
        site.latitude = parseFloatOrUndefined(val) ?? 0;
        break;
      case "longitude":
        site.longitude = parseFloatOrUndefined(val) ?? 0;
        break;
      case "elevation_m": {
        const f = parseFloatOrUndefined(val);
        if (f !== undefined) site.elevation_m = f;
        break;
      }
      case "view_latitude":
        site.view_latitude = parseFloatOrUndefined(val) ?? 0;
        break;
      case "view_longitude":
        site.view_longitude = parseFloatOrUndefined(val) ?? 0;
        break;
      case "view_zoom":
        site.view_zoom = parseFloatOrUndefined(val) ?? 0;
        break;
      case "view_bearing": {
        const f = parseFloatOrUndefined(val);
        if (f !== undefined) site.view_bearing = f;
        break;
      }
      case "view_pitch":
        site.view_pitch = parseFloatOrUndefined(val) ?? 0;
        break;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;

    if (mode === "top" && line === "references:") {
      mode = "refs";
      continue;
    }
    if (mode === "refs") {
      const itemMatch = refItemRe.exec(line);
      if (itemMatch) {
        flush();
        current = {};
        setRefField(current, itemMatch[1], trimQuotes(itemMatch[2]));
        continue;
      }
      const fieldMatch = refFieldRe.exec(line);
      if (fieldMatch && current != null) {
        setRefField(current, fieldMatch[1], trimQuotes(fieldMatch[2]));
        continue;
      }
      mode = "top";
    }
    if (mode === "top") {
      const m = topLineRe.exec(line);
      if (m) setTopField(m[1], trimQuotes(m[2]));
    }
  }
  flush();
  return site;
}

const yamlSpecialLead = `-?:,[]{}#&*!|>'"%@\``;

function yamlScalar(s: string): string {
  const needsQuote =
    s === "" ||
    s.includes(": ") ||
    s.includes(" #") ||
    /[\r\n]/.test(s) ||
    s !== s.trim() ||
    (s.length > 0 && yamlSpecialLead.includes(s[0]));
  if (!needsQuote) return s;
  let esc = s.replaceAll("\\", "\\\\");
  esc = esc.replaceAll('"', '\\"');
  esc = esc.replaceAll("\r\n", "\\n");
  esc = esc.replaceAll("\n", "\\n");
  return `"${esc}"`;
}

// Go's strconv.FormatFloat(v, 'f', -1, 64): shortest decimal that
// round-trips exactly, never exponential notation. JS's Number#toString
// matches this for realistic lat/lng/zoom magnitudes but can fall back to
// exponential notation outside roughly 1e-7..1e21 -- toFixed handles that
// edge case for values this app will never actually see.
function formatNum(v: number): string {
  const s = v.toString();
  if (s.includes("e") || s.includes("E")) return v.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

// The write side: renders a Site into the same byte-for-byte format
// parseSiteYaml reads, field order included. Mirrors renderSiteYaml in
// server/siteyaml.go exactly.
export function renderSiteYaml(site: Site): string {
  let out = "";
  out += "name: " + yamlScalar(site.name) + "\n";
  out += "area: " + yamlScalar(site.area) + "\n";
  out += "description: " + yamlScalar(site.description) + "\n";
  out += "hazards: " + yamlScalar(site.hazards) + "\n";
  out += "latitude: " + formatNum(site.latitude) + "\n";
  out += "longitude: " + formatNum(site.longitude) + "\n";
  if (site.elevation_m != null) out += "elevation_m: " + formatNum(site.elevation_m) + "\n";
  out += "view_latitude: " + formatNum(site.view_latitude) + "\n";
  out += "view_longitude: " + formatNum(site.view_longitude) + "\n";
  out += "view_zoom: " + formatNum(site.view_zoom) + "\n";
  if (site.view_bearing != null) out += "view_bearing: " + formatNum(site.view_bearing) + "\n";
  out += "view_pitch: " + formatNum(site.view_pitch) + "\n";
  if (site.references.length > 0) {
    out += "references:\n";
    for (const r of site.references) {
      out += "    - type: " + yamlScalar(r.type) + "\n";
      out += "      title: " + yamlScalar(r.title) + "\n";
      if (r.description !== "") out += "      description: " + yamlScalar(r.description) + "\n";
      out += "      url: " + yamlScalar(r.url) + "\n";
    }
  }
  return out;
}

export function slugify(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/^-+/, "").replace(/-+$/, "");
  return s === "" ? "site" : s;
}

// Basename-only + character allowlist, matching server/siteyaml.go's
// safeFileName exactly (filepath.Base then a regex replace).
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned === "" || cleaned === "." ? "file" : cleaned;
}
