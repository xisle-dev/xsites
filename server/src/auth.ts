// Pluggable request authentication. index.ts calls Authenticator.authenticate
// for every /admin and /api request and checks the result against an email
// allowlist itself -- the app enforces authorization, not just whatever
// fronts it. On Cloudflare, Access *also* blocks unauthenticated requests to
// those paths at the edge (see server/scripts/setup-access.sh), so this is
// redundant there today -- but it's what would actually enforce the policy
// running anywhere else, and it means a client can't reach /api by hitting
// the Worker directly with a forged header unless that header's signature
// genuinely verifies.
//
// CloudflareAccessAuthenticator is the only implementation today. A
// self-hosted deployment would swap in something session/cookie-based
// instead; nothing outside this file needs to change.

export interface Identity {
  email: string;
}

export interface Authenticator {
  // Null if the request carries no recognizable, validly-signed identity.
  // Never throws -- verification failures (bad signature, expired, wrong
  // audience, network error fetching keys) all just mean "not this user".
  authenticate(request: Request): Promise<Identity | null>;
  // What to hand back to a request that failed the allowlist check --
  // typically a redirect to a login page.
  challenge(request: Request): Response;
}

function base64UrlToStd(s: string): string {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (std.length % 4)) % 4;
  return std + "=".repeat(pad);
}

function base64UrlDecodeText(s: string): string {
  return atob(base64UrlToStd(s));
}

function base64UrlDecodeBytes(s: string): Uint8Array {
  const binary = base64UrlDecodeText(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Verifies Cloudflare Access JWTs (from the Cf-Access-Jwt-Assertion header
// Access injects when it fronts a request, or the CF_Authorization cookie a
// previously-authenticated browser carries) against the team's published
// JWKS -- real signature verification via Web Crypto, not just "a header is
// present". aud/exp/email are all checked; only email is returned, since
// that's all index.ts's allowlist check needs.
export class CloudflareAccessAuthenticator implements Authenticator {
  private jwksCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
  private static readonly jwksTtlMs = 60 * 60 * 1000;

  constructor(
    private teamDomain: string,
    private aud: string,
  ) {}

  private async getJwks(): Promise<JsonWebKey[]> {
    const now = Date.now();
    if (this.jwksCache && now - this.jwksCache.fetchedAt < CloudflareAccessAuthenticator.jwksTtlMs) {
      return this.jwksCache.keys;
    }
    const res = await fetch(`https://${this.teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`fetching Access certs: ${res.status}`);
    const data = (await res.json()) as { keys: JsonWebKey[] };
    this.jwksCache = { keys: data.keys, fetchedAt: now };
    return data.keys;
  }

  async authenticate(request: Request): Promise<Identity | null> {
    const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? getCookie(request, "CF_Authorization");
    if (!token) return null;
    try {
      return await this.verify(token);
    } catch {
      return null;
    }
  }

  private async verify(token: string): Promise<Identity> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed JWT");
    const [headerB64, payloadB64, sigB64] = parts;

    const header = JSON.parse(base64UrlDecodeText(headerB64)) as { kid?: string; alg?: string };
    const payload = JSON.parse(base64UrlDecodeText(payloadB64)) as {
      email?: string;
      aud?: string | string[];
      exp?: number;
    };

    const jwks = await this.getJwks();
    const jwk = jwks.find((k) => (k as { kid?: string }).kid === header.kid);
    if (!jwk) throw new Error("no matching Access signing key");

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signature = base64UrlDecodeBytes(sigB64);
    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
    if (!valid) throw new Error("invalid JWT signature");

    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error("expired token");
    }
    const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud != null ? [payload.aud] : [];
    if (!auds.includes(this.aud)) throw new Error("audience mismatch");
    if (typeof payload.email !== "string" || payload.email === "") throw new Error("no email claim");

    return { email: payload.email };
  }

  challenge(request: Request): Response {
    // On Cloudflare this branch is effectively unreachable in production --
    // Access already blocks the request at the edge before fetch() runs
    // for /admin* and /api* (see setup-access.sh) -- but matters for any
    // deployment where this authenticator's the only enforcement.
    const url = new URL(request.url);
    const loginUrl = new URL(`https://${this.teamDomain}/cdn-cgi/access/login/${url.host}`);
    loginUrl.searchParams.set("redirect_url", url.pathname + url.search);
    return Response.redirect(loginUrl.toString(), 302);
  }
}
