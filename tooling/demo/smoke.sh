#!/usr/bin/env bash
# CI: the Codespaces demo starts, shows the interface and answers through the interface's address.
set -u
cd "$(dirname "$0")/../.."
(cd apps/desktop && VITE_ADAPTER=web VITE_API_URL= pnpm exec vite build --outDir dist-demo --emptyOutDir) > /tmp/demo-build.log 2>&1 || { tail -n 30 /tmp/demo-build.log; exit 1; }
node apps/server/demo/demo-server.mjs < /dev/null > /tmp/demo-server.log 2>&1 &
SERVER=$!
(cd apps/desktop && exec env VITE_ADAPTER=web VITE_API_URL= ALYASSIR_DEMO_API=http://127.0.0.1:4300 pnpm exec vite preview --outDir dist-demo --port 5173 --strictPort --host 0.0.0.0) < /dev/null > /tmp/demo-ui.log 2>&1 &
UI=$!
# Stop both programs at the end, whatever happens (otherwise the CI step never ends).
trap 'kill $SERVER $UI 2>/dev/null; pkill -f "vite preview" 2>/dev/null; true' EXIT
fail() { echo "DEMO FAILED: $1"; tail -n 40 /tmp/demo-server.log; tail -n 20 /tmp/demo-ui.log; exit 1; }
for i in $(seq 1 60); do grep -q "sample data added" /tmp/demo-server.log && break; sleep 2; done
grep -q "sample data added" /tmp/demo-server.log || fail "sample data not added"
for i in $(seq 1 30); do curl -sf http://127.0.0.1:5173/ > /dev/null && break; sleep 2; done
curl -sf -H "Host: demo-5173.app.github.dev" http://127.0.0.1:5173/ | grep -q '<div id="root">' || fail "interface page"
H=(-H "content-type: application/json" -H "x-alyassir-client-version: 0.1.0")
curl -sf http://127.0.0.1:5173/api/health | grep -q '"status":"ok"' || fail "health through the interface address"
TOKEN=$(curl -sf "${H[@]}" -d '{"username":"gerant","password":"gerant123"}' http://127.0.0.1:5173/api/auth/login | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken') || fail "login"
TOTAL=$(curl -sf "${H[@]}" -H "authorization: Bearer $TOKEN" "http://127.0.0.1:5173/api/policies" | node -pe 'JSON.parse(require("fs").readFileSync(0)).total')
[ "$TOTAL" = "3" ] || fail "expected 3 sample policies, got $TOTAL"
INCOLL=$(curl -sf "${H[@]}" -H "authorization: Bearer $TOKEN" "http://127.0.0.1:5173/api/payments?status=in_collection" | node -pe 'JSON.parse(require("fs").readFileSync(0)).total')
[ "$INCOLL" = "1" ] || fail "expected 1 sample cheque in collection, got $INCOLL"
(cd apps/desktop && node scripts/demo-check.mjs http://127.0.0.1:5173) || fail "real browser"
echo "Demo OK: interface, API, sample data, sign-in in a real browser"
