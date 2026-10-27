#!/usr/bin/env bash
# Runs a CI command. On failure, the end of its output becomes a GitHub annotation,
# because raw CI logs cannot be downloaded from the development environment.
# Usage: tooling/ci-run.sh "<title>" <command> [args...]
title="$1"; shift
out="$(mktemp)"
"$@" 2>&1 | tee "$out"
code=${PIPESTATUS[0]}
if [ "$code" -ne 0 ]; then
  tail -n 80 "$out" | sed -e 's/\x1b\[[0-9;]*m//g' | cut -c1-400 > "$out.tail"
  body="$(sed -e 's/%/%25/g' "$out.tail" | sed -e ':a;N;$!ba;s/\r//g;s/\n/%0A/g')"
  echo "::error title=${title}::${body}"
fi
exit "$code"
