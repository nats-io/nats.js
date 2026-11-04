#!/usr/bin/env bash
# publishes each workspace to npm in dependency order, skipping versions that
# are already on npm, so a failed release can be rerun until it succeeds.
# extra arguments (such as --dry-run) are passed to npm publish.
set -u
failed=()
for m in core nst jetstream kv obj services transport-node; do
  name=$(node -p "require('./$m/package.json').name")
  ver=$(node -p "require('./$m/package.json').version")
  if [ -n "$(npm view "$name@$ver" version 2>/dev/null)" ]; then
    echo "$name@$ver is already on npm, skipping"
    continue
  fi
  if ! (cd "$m" && npm publish --provenance --access public --tag="${NPM_TAG}" "$@"); then
    failed+=("$name@$ver")
  fi
done
if [ "${#failed[@]}" -gt 0 ]; then
  echo "failed to publish: ${failed[*]}" >&2
  exit 1
fi
