#!/usr/bin/env bash
# CI: starts the demo exactly like GitHub Codespaces does (same container file, same start steps),
# then checks from inside it that the interface and the API answer on port 5173.
set -u
npx -y @devcontainers/cli up --workspace-folder . > /tmp/devcontainer-up.log 2>&1
code=$?
tail -n 60 /tmp/devcontainer-up.log
[ $code -eq 0 ] || { echo "DEVCONTAINER UP FAILED"; exit 1; }
run() { npx -y @devcontainers/cli exec --workspace-folder . bash -lc "$1"; }
for i in $(seq 1 90); do
  if run "curl -sf http://127.0.0.1:5173/api/health" | grep -q '"status":"ok"'; then ok=1; break; fi
  sleep 5
done
run "tail -n 30 /tmp/alyassir-server.log; tail -n 15 /tmp/alyassir-ui.log"
[ "${ok:-0}" = "1" ] || { echo "DEMO DID NOT ANSWER ON 5173"; exit 1; }
run "curl -sf http://127.0.0.1:5173/ | grep -q 'id=\"root\"'" || { echo "INTERFACE PAGE MISSING"; exit 1; }
echo "Codespaces demo OK"
