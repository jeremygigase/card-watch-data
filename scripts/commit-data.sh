#!/usr/bin/env bash
# Commits the data as a single commit that replaces the previous one.
# All history lives inside the files (history/), so old commits add nothing but size.
# Without this, the repository would grow by tens of megabytes every day.
set -euo pipefail
message="${1:-Update data}"

git config user.name "card-watch-bot"
git config user.email "actions@users.noreply.github.com"

git add -A
if git diff --cached --quiet; then
  echo "Nothing changed."
  exit 0
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
git checkout --orphan _fresh
git commit -q -m "$message"
git branch -D "$branch" >/dev/null
git branch -m "$branch"
git push --force origin "$branch"
echo "Pushed: $message"
