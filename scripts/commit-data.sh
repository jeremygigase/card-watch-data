#!/usr/bin/env bash
# Commits the data as a single commit that replaces the previous one, on the `data` branch only.
# All history lives inside the files (history/), so old commits add nothing but size.
# Without this, the repository would grow by tens of megabytes every day.
# The code lives on `main` with a normal history; this script must never run there.
set -euo pipefail
message="${1:-Update data}"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "data" ]; then
  echo "Refusing to squash '$branch': run this inside a checkout of the data branch." >&2
  exit 1
fi

git config user.name "card-watch-bot"
git config user.email "actions@users.noreply.github.com"

git add -A
if git diff --cached --quiet; then
  echo "Nothing changed."
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "changed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

git checkout --orphan _fresh
git commit -q -m "$message"
git branch -D "$branch" >/dev/null
git branch -m "$branch"
git push --force origin "$branch"
echo "Pushed: $message"
[ -n "${GITHUB_OUTPUT:-}" ] && echo "changed=true" >> "$GITHUB_OUTPUT"
exit 0
