#!/usr/bin/env bash
# Idempotently configures Cloudflare Access in front of the xsites editor
# Worker: a self-hosted Access application on the given hostname (optionally
# scoped to specific path patterns, so the rest of the hostname stays
# public), an email One-Time-PIN login method (Cloudflare's default, but not
# auto-provisioned on a fresh Zero Trust account), and an allow policy for
# each address passed in. Safe to re-run -- every step checks for an
# existing resource by name/domain before creating one. See github issues
# #19 and #20 -- and the "public read-only + gated /admin" split described
# there, since worker/index.ts serves a public read-only viewer at "/" with
# the full CRUD editor moved to "/admin", so only "/admin" and "/api" need
# to sit behind Access.
#
# Requires:
#   - Zero Trust already enabled on the account (one-time, dashboard-only --
#     Cloudflare has no API for this step: dash.cloudflare.com -> Zero Trust
#     -> pick a team name).
#   - A Cloudflare API token with "Access: Apps and Policies: Edit" and
#     "Access: Organizations, Identity Providers, and Groups: Edit"
#     (My Profile -> API Tokens -> Create Token -> Custom Token).
#
# Usage:
#   CF_ACCOUNT_ID=... CF_ACCESS_TOKEN=... ./setup-access.sh [--paths p1,p2,...] \
#     <domain> <email> [more emails...]
#
#   --paths defaults to "admin*,api*" (matching <domain>/admin* and
#   <domain>/api*); pass --paths "" (or just omit any path segment) to
#   protect the whole domain instead, e.g. for a bare workers.dev fallback
#   host with no public split.
#
#   Also renames the account's Zero Trust team domain and brands the login
#   page (background/text color, logo, header/footer text) -- this is
#   account-wide, not specific to this one Access application. Override any
#   of it with CF_TEAM_NAME, CF_LOGIN_LOGO, CF_LOGIN_BG, CF_LOGIN_TEXT_COLOR,
#   CF_LOGIN_HEADER, CF_LOGIN_FOOTER env vars; defaults assume the X/Sites
#   branding and a logo already served at <domain>/logo.svg.

set -euo pipefail

PATHS="admin*,api*"
if [ "${1:-}" = "--paths" ]; then
  PATHS="$2"
  shift 2
fi

ACCOUNT_ID="${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID (see: wrangler whoami)}"
TOKEN="${CF_ACCESS_TOKEN:?set CF_ACCESS_TOKEN to a token with Access edit permissions}"
DOMAIN="${1:?usage: setup-access.sh [--paths p1,p2,...] <domain> <email> [email...]}"
shift
EMAILS=("$@")
if [ "${#EMAILS[@]}" -eq 0 ]; then
  echo "usage: setup-access.sh [--paths p1,p2,...] <domain> <email> [email...]" >&2
  exit 1
fi

API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID"
auth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

# Build the destinations array: one entry per path pattern (each protecting
# <domain>/<path>), or a single whole-domain entry if PATHS is empty.
if [ -z "$PATHS" ]; then
  destinations=$(jq -n --arg d "$DOMAIN" '[{type: "public", uri: $d}]')
  match_domain="$DOMAIN"
else
  destinations=$(IFS=,; for p in $PATHS; do printf '%s/%s\n' "$DOMAIN" "$p"; done \
    | jq -R '{type: "public", uri: .}' | jq -s .)
  match_domain=$(IFS=,; set -- $PATHS; printf '%s/%s' "$DOMAIN" "$1")
fi

# --- One-time PIN identity provider ---------------------------------------
idp_id=$(curl -sS "$API/access/identity_providers" "${auth[@]}" \
  | jq -r '.result[] | select(.type == "onetimepin") | .id' | head -1)
if [ -z "$idp_id" ]; then
  echo "Creating One-time PIN identity provider..."
  idp_id=$(curl -sS -X POST "$API/access/identity_providers" "${auth[@]}" \
    -d '{"name": "One-time PIN", "type": "onetimepin", "config": {}}' \
    | jq -r '.result.id')
else
  echo "One-time PIN identity provider already exists ($idp_id)."
fi

# --- Self-hosted Access application ----------------------------------------
# Matched by the first destination's exact string, which is stable across
# re-runs as long as PATHS's first entry doesn't change.
app_id=$(curl -sS "$API/access/apps" "${auth[@]}" \
  | jq -r --arg d "$match_domain" '.result[] | select(.domain == $d or (.self_hosted_domains // [] | index($d))) | .id' | head -1)

app_body=$(jq -n --arg idp "$idp_id" --argjson destinations "$destinations" \
  '{name: "xsites editor", type: "self_hosted", session_duration: "24h", auto_redirect_to_identity: false, allowed_idps: [$idp], destinations: $destinations}')

if [ -z "$app_id" ]; then
  echo "Creating Access application for $DOMAIN (paths: ${PATHS:-<whole domain>})..."
  app_id=$(curl -sS -X POST "$API/access/apps" "${auth[@]}" -d "$app_body" | jq -r '.result.id')
else
  echo "Access application for $DOMAIN already exists ($app_id), updating..."
  curl -sS -X PUT "$API/access/apps/$app_id" "${auth[@]}" -d "$app_body" >/dev/null
fi

# --- Allow policy ------------------------------------------------------------
policy_id=$(curl -sS "$API/access/apps/$app_id/policies" "${auth[@]}" \
  | jq -r '.result[] | select(.name == "allow-owner-email-otp") | .id' | head -1)

# jq builds the emails array as [{"email":{"email":"..."}}, ...]
policy_include=$(printf '%s\n' "${EMAILS[@]}" | jq -R '{email: {email: .}}' | jq -s .)
policy_body=$(jq -n --argjson include "$policy_include" \
  '{name: "allow-owner-email-otp", decision: "allow", include: $include}')

if [ -z "$policy_id" ]; then
  echo "Creating allow policy..."
  curl -sS -X POST "$API/access/apps/$app_id/policies" "${auth[@]}" -d "$policy_body" >/dev/null
else
  echo "Allow policy already exists ($policy_id), updating..."
  curl -sS -X PUT "$API/access/apps/$app_id/policies/$policy_id" "${auth[@]}" -d "$policy_body" >/dev/null
fi

# --- Branded login page + team domain ---------------------------------------
# The login page itself (and its URL, <team-name>.cloudflareaccess.com) are
# account-wide, not per-application -- PATCHing access/organizations is
# idempotent on its own (no existence check needed, just re-applies).
TEAM_NAME="${CF_TEAM_NAME:-xsites}"
LOGIN_LOGO="${CF_LOGIN_LOGO:-https://$DOMAIN/logo.svg}"
LOGIN_BG="${CF_LOGIN_BG:-#14161a}"
LOGIN_TEXT_COLOR="${CF_LOGIN_TEXT_COLOR:-#f2f2f2}"
LOGIN_HEADER="${CF_LOGIN_HEADER:-X/Sites}"
LOGIN_FOOTER="${CF_LOGIN_FOOTER:-Sign in to edit the X/Sites database.}"

org_body=$(jq -n \
  --arg name "$TEAM_NAME" \
  --arg auth_domain "$TEAM_NAME.cloudflareaccess.com" \
  --arg bg "$LOGIN_BG" --arg text "$LOGIN_TEXT_COLOR" \
  --arg logo "$LOGIN_LOGO" --arg header "$LOGIN_HEADER" --arg footer "$LOGIN_FOOTER" \
  '{name: $name, auth_domain: $auth_domain, login_design: {background_color: $bg, text_color: $text, logo_path: $logo, header_text: $header, footer_text: $footer}}')
echo "Setting team domain to $TEAM_NAME.cloudflareaccess.com and branding the login page..."
curl -sS -X PATCH "$API/access/organizations" "${auth[@]}" -d "$org_body" >/dev/null

echo "Done. $DOMAIN (paths: ${PATHS:-<whole domain>}) is now protected; allowed: ${EMAILS[*]}"
echo "Login page: https://$TEAM_NAME.cloudflareaccess.com"
