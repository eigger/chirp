#!/usr/bin/env bash
# Assemble the runtime tree of a release into <outdir> (used by release.yml and
# the Dockerfile, so the tarball and the image ship the same files).
#
# Run after `npm run build` and `npm prune --omit=dev`. Copies the root
# node_modules *and* any workspace-level node_modules (npm nests a dependency
# under apps/<x>/node_modules or packages/<x>/node_modules when versions clash
# and it cannot be hoisted), so the runtime never depends on hoisting luck.
set -euo pipefail

OUT="${1:?usage: scripts/package-release.sh <outdir>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for f in apps/server/dist/index.js apps/server/dist/cli.js apps/web/dist/index.html packages/shared/dist/index.js; do
  [[ -f "$f" ]] || { echo "package-release: missing $f (run npm run build first)" >&2; exit 1; }
done

mkdir -p "$OUT"
paths=(
  package.json
  node_modules
  packages/shared/package.json packages/shared/dist
  apps/server/package.json apps/server/dist
  apps/web/dist
)
for ws in packages/shared apps/server apps/web; do
  if [[ -d "$ws/node_modules" ]] && [[ -n "$(ls -A "$ws/node_modules")" ]]; then
    paths+=("$ws/node_modules")
  fi
done

# tar keeps the relative workspace symlinks (node_modules/@chirp/* -> ../../<ws>).
tar -cf - "${paths[@]}" | tar -xf - -C "$OUT"
echo "package-release: wrote ${#paths[@]} paths to $OUT"
