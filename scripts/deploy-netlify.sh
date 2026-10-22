#!/usr/bin/env bash
# Publishes the data (checked out in data/) to the Netlify price data site, behind the sign-in check in
# netlify/edge-functions/require-login.ts. Run it from the repository root (main), so Netlify finds netlify.toml.
# Needs NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID. Netlify uploads only the files that changed.
set -euo pipefail

: "${NETLIFY_AUTH_TOKEN:?Set the NETLIFY_AUTH_TOKEN secret}"
: "${NETLIFY_SITE_ID:?Set the NETLIFY_SITE_ID secret}"
[ -f data/manifest.json ] || { echo "No data/manifest.json: check out the data branch into data/ first." >&2; exit 1; }

site="${RUNNER_TEMP:-$(mktemp -d)}/site"
rm -rf "$site" && mkdir -p "$site"
rsync -a --exclude '.git' --exclude 'archive/' --exclude '.cache/' --exclude 'mapping-report.html' data/ "$site/"

npx --yes netlify-cli@27.11.2 deploy --prod --no-build --dir "$site" --message "${1:-Price data}"
