// A dynamic allowlist + invite system, built on the same ObjectStore
// abstraction as everything else -- replaces the old static
// ACCESS_ALLOWED_EMAILS wrangler.toml var, which needed a redeploy to add
// or remove anyone. Lives in LIVE_DATA (private app state, not public data
// the way the site records' media is).
//
// Authentication (proving a request really does control the email it
// claims) is still entirely Cloudflare Access's job -- see auth.ts. This
// module is purely about authorization: once Access has verified *some*
// real, working email, is *this* email allowed in. See github issue/commit
// history around "send an invitation" for why Access's own policy moved
// from an email allowlist to "anyone who completes OTP".

import type { ObjectStore } from "./objectstore";

const ALLOWLIST_KEY = "access/allowlist.json";
const INVITE_PREFIX = "access/invites/";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Invite {
  token: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

const textDecoder = new TextDecoder();

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export async function getAllowedEmails(store: ObjectStore): Promise<string[]> {
  const obj = await store.get(ALLOWLIST_KEY);
  if (!obj) return [];
  try {
    const data = JSON.parse(textDecoder.decode(obj.data)) as { emails?: unknown };
    return Array.isArray(data.emails) ? data.emails.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

export async function isEmailAllowed(store: ObjectStore, email: string): Promise<boolean> {
  const emails = await getAllowedEmails(store);
  return emails.includes(normalize(email));
}

export async function addAllowedEmail(store: ObjectStore, email: string): Promise<void> {
  const emails = await getAllowedEmails(store);
  const normalized = normalize(email);
  if (!emails.includes(normalized)) emails.push(normalized);
  await store.put(ALLOWLIST_KEY, JSON.stringify({ emails }), "application/json; charset=utf-8");
}

export async function removeAllowedEmail(store: ObjectStore, email: string): Promise<void> {
  const emails = await getAllowedEmails(store);
  const normalized = normalize(email);
  await store.put(
    ALLOWLIST_KEY,
    JSON.stringify({ emails: emails.filter((e) => e !== normalized) }),
    "application/json; charset=utf-8",
  );
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Invite tokens are hex-only by construction; this also doubles as a guard
// against a malformed/hostile URL segment turning into an unexpected R2 key.
function isValidToken(token: string): boolean {
  return /^[a-f0-9]{48}$/.test(token);
}

function inviteKey(token: string): string {
  return `${INVITE_PREFIX}${token}.json`;
}

export async function createInvite(store: ObjectStore, email: string): Promise<Invite> {
  const now = new Date();
  const invite: Invite = {
    token: randomToken(),
    email: normalize(email),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
    acceptedAt: null,
  };
  await store.put(inviteKey(invite.token), JSON.stringify(invite), "application/json; charset=utf-8");
  return invite;
}

export async function listInvites(store: ObjectStore): Promise<Invite[]> {
  const keys = await store.list(INVITE_PREFIX);
  const invites: Invite[] = [];
  for (const key of keys) {
    const obj = await store.get(key);
    if (!obj) continue;
    try {
      invites.push(JSON.parse(textDecoder.decode(obj.data)) as Invite);
    } catch {
      // skip anything unreadable
    }
  }
  invites.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return invites;
}

export async function getInvite(store: ObjectStore, token: string): Promise<Invite | null> {
  if (!isValidToken(token)) return null;
  const obj = await store.get(inviteKey(token));
  if (!obj) return null;
  try {
    return JSON.parse(textDecoder.decode(obj.data)) as Invite;
  } catch {
    return null;
  }
}

export async function revokeInvite(store: ObjectStore, token: string): Promise<void> {
  if (!isValidToken(token)) return;
  await store.delete(inviteKey(token));
}

// Marks the invite accepted and adds its email to the allowlist. Returns
// null (does nothing else) if the token doesn't exist, is expired, or was
// already accepted -- callers should treat that as "invalid invite" and
// show an error rather than silently granting access.
export async function acceptInvite(store: ObjectStore, token: string): Promise<Invite | null> {
  const invite = await getInvite(store, token);
  if (!invite || invite.acceptedAt) return null;
  if (new Date(invite.expiresAt).getTime() < Date.now()) return null;

  invite.acceptedAt = new Date().toISOString();
  await store.put(inviteKey(token), JSON.stringify(invite), "application/json; charset=utf-8");
  await addAllowedEmail(store, invite.email);
  return invite;
}
