#!/usr/bin/env bash
# publishes each workspace to npm in dependency order, skipping versions that
# are already on npm (or that another run publishes first, npm's E409), so a
# failed release can be rerun until it succeeds.
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
  out=$(cd "$m" && npm publish --provenance --access public --tag="${NPM_TAG}" "$@" 2>&1)
  status=$?
  echo "$out"
  if [ $status -ne 0 ]; then
    # E409: another run published (or staged) this version first
    if echo "$out" | grep -q "E409"; then
      echo "$name@$ver was published by another run, skipping"
    else
      failed+=("$name@$ver")
    fi
  fi
done
if [ "${#failed[@]}" -gt 0 ]; then
  echo "failed to publish: ${failed[*]}" >&2
  exit 1
fi
