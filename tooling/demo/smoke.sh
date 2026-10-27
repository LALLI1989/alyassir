#!/usr/bin/env bash
# CI: the Codespaces demo starts, shows the interface and answers through the interface's address.
set -u
cd "$(dirname "$0")/../.."
node apps/server/demo/demo-server.mjs > /tmp/demo-server.log 2>&1 &
(cd apps/desktop && VITE_ADAPTER=web VITE_API_URL= ALYASSIR_DEMO_API=http://127.0.0.1:4300 pnpm exec vite --port 5173 --strictPort --host 0.0.0.0 > /tmp/demo-ui.log 2>&1 &)
fail() { echo "DEMO FAILED: $1"; tail -n 40 /tmp/demo-server.log; tail -n 20 /tmp/demo-ui.log; exit 1; }
for i in $(seq 1 60); do grep -q "sample data added" /tmp/demo-server.log && break; sleep 2; done
grep -q "sample data added" /tmp/demo-server.log || fail "sample data not added"
for i in $(seq 1 30); do curl -sf http://127.0.0.1:5173/ > /dev/null && break; sleep 2; done
curl -sf -H "Host: demo-5173.app.github.dev" http://127.0.0.1:5173/ | grep -q '<div id="root">' || fail "interface page"
H=(-H "content-type: application/json" -H "x-alyassir-client-version: 0.1.0")
curl -sf http://127.0.0.1:5173/api/health | grep -q '"status":"ok"' || fail "health through the interface address"
TOKEN=$(curl -sf "${H[@]}" -d '{"username":"gerant","password":"gerant123"}' http://127.0.0.1:5173/api/auth/login | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken') || fail "login"
TOTAL=$(curl -sf "${H[@]}" -H "authorization: Bearer $TOKEN" "http://127.0.0.1:5173/api/policies" | node -pe 'JSON.parse(require("fs").readFileSync(0)).total')
[ "$TOTAL" = "2" ] || fail "expected 2 sample policies, got $TOTAL"
echo "Demo OK: interface, API and sample data"
