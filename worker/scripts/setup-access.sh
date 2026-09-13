#!/usr/bin/env bash
# Idempotently configures Cloudflare Access in front of the xsites editor
# Worker: a self-hosted Access application on the given hostname, an
# email One-Time-PIN login method (Cloudflare's default, but not
# auto-provisioned on a fresh Zero Trust account), and an allow policy for
# each address passed in. Safe to re-run -- every step checks for an
# existing resource by name/domain before creating one. See github issue #19.
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
#   CF_ACCOUNT_ID=... CF_ACCESS_TOKEN=... ./setup-access.sh \
#     xsites-editor.gtissington.workers.dev gtissington@gmail.com [more emails...]

set -euo pipefail

ACCOUNT_ID="${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID (see: wrangler whoami)}"
TOKEN="${CF_ACCESS_TOKEN:?set CF_ACCESS_TOKEN to a token with Access edit permissions}"
DOMAIN="${1:?usage: setup-access.sh <domain> <email> [email...]}"
shift
EMAILS=("$@")
if [ "${#EMAILS[@]}" -eq 0 ]; then
  echo "usage: setup-access.sh <domain> <email> [email...]" >&2
  exit 1
fi

API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID"
auth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

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
app_id=$(curl -sS "$API/access/apps" "${auth[@]}" \
  | jq -r --arg d "$DOMAIN" '.result[] | select(.domain == $d) | .id' | head -1)

# jq builds the emails array as {"type":"allow","include":[{"email":{"email":"..."}}, ...]}
policy_include=$(printf '%s\n' "${EMAILS[@]}" | jq -R '{email: {email: .}}' | jq -s .)

app_body=$(jq -n --arg domain "$DOMAIN" --arg idp "$idp_id" \
  '{name: "xsites editor", domain: $domain, type: "self_hosted", session_duration: "24h", auto_redirect_to_identity: false, allowed_idps: [$idp]}')

if [ -z "$app_id" ]; then
  echo "Creating Access application for $DOMAIN..."
  app_id=$(curl -sS -X POST "$API/access/apps" "${auth[@]}" -d "$app_body" | jq -r '.result.id')
else
  echo "Access application for $DOMAIN already exists ($app_id), updating..."
  curl -sS -X PUT "$API/access/apps/$app_id" "${auth[@]}" -d "$app_body" >/dev/null
fi

# --- Allow policy ------------------------------------------------------------
policy_id=$(curl -sS "$API/access/apps/$app_id/policies" "${auth[@]}" \
  | jq -r '.result[] | select(.name == "allow-owner-email-otp") | .id' | head -1)

policy_body=$(jq -n --argjson include "$policy_include" \
  '{name: "allow-owner-email-otp", decision: "allow", include: $include}')

if [ -z "$policy_id" ]; then
  echo "Creating allow policy..."
  curl -sS -X POST "$API/access/apps/$app_id/policies" "${auth[@]}" -d "$policy_body" >/dev/null
else
  echo "Allow policy already exists ($policy_id), updating..."
  curl -sS -X PUT "$API/access/apps/$app_id/policies/$policy_id" "${auth[@]}" -d "$policy_body" >/dev/null
fi

echo "Done. $DOMAIN is now protected; allowed: ${EMAILS[*]}"
