#!/usr/bin/env bash
# Compress an image to a JPEG under a size limit (macOS, uses built-in sips).
# Usage: scripts/compress-image.sh <input> [output.jpg] [max-kb=400]
set -euo pipefail

in="${1:?usage: compress-image.sh <input> [output.jpg] [max-kb=400]}"
out="${2:-${in%.*}-small.jpg}"
max_kb="${3:-400}"

[ -f "$in" ] || { echo "input not found: $in" >&2; exit 1; }

# Try progressively smaller dimension / lower quality until under the limit.
for dim in 1280 1024 768 512; do
  for q in 80 60 40; do
    sips -s format jpeg -s formatOptions "$q" -Z "$dim" "$in" --out "$out" >/dev/null
    kb=$(( $(stat -f%z "$out") / 1024 ))
    if [ "$kb" -le "$max_kb" ]; then
      echo "ok: $out (${kb}KB, max side ${dim}px, quality ${q})"
      exit 0
    fi
  done
done

echo "could not get under ${max_kb}KB; last result: $out (${kb}KB)" >&2
exit 1
