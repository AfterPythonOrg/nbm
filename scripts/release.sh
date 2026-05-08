#!/usr/bin/env bash
# Cut a release: bump version across all four npm packages, commit, tag, push.
# CI (.github/workflows/release.yml) takes over from there.
#
# Usage: ./scripts/release.sh <semver>     e.g. ./scripts/release.sh 0.1.0

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <semver>" >&2
  echo "  e.g.  $0 0.1.0" >&2
  exit 2
fi

VERSION="$1"

# Validate semver shape (loose: allow prereleases).
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Refusing: '$VERSION' is not a valid semver." >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# Sanity checks.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing: working tree has uncommitted changes." >&2
  git status --short >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "Refusing: not on main (currently on '$BRANCH')." >&2
  exit 1
fi

git fetch origin --quiet
LOCAL="$(git rev-parse @)"
REMOTE="$(git rev-parse @{u} 2>/dev/null || echo none)"
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "Refusing: local main is not up-to-date with origin." >&2
  echo "  local:  $LOCAL" >&2
  echo "  remote: $REMOTE" >&2
  exit 1
fi

if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "Refusing: tag v$VERSION already exists." >&2
  exit 1
fi

# Bump versions atomically. We use a tiny inline node to keep JSON formatting clean.
echo "-- Bumping all four packages to $VERSION"
for pkg in npm/nbm npm/cli-darwin-arm64 npm/cli-darwin-x64 npm/cli-linux-x64; do
  node -e "
    const fs = require('fs');
    const path = '$pkg/package.json';
    const j = JSON.parse(fs.readFileSync(path, 'utf8'));
    j.version = '$VERSION';
    if (j.optionalDependencies) {
      for (const k of Object.keys(j.optionalDependencies)) {
        if (k.startsWith('@afterpython/nbm-cli-')) j.optionalDependencies[k] = '$VERSION';
      }
    }
    fs.writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
  "
done

git add npm/nbm/package.json npm/cli-darwin-arm64/package.json npm/cli-darwin-x64/package.json npm/cli-linux-x64/package.json
git commit -m "release: v$VERSION"
git tag "v$VERSION"

echo "-- Pushing branch + tag"
git push origin main
git push origin "v$VERSION"

REPO_URL="$(git config --get remote.origin.url | sed -e 's|git@github.com:|https://github.com/|' -e 's|\.git$||')"
echo
echo "Released v$VERSION."
echo "Watch CI: $REPO_URL/actions"
