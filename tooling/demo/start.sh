#!/usr/bin/env bash
# Codespaces only: starts the demo (server + interface on port 5173) and waits until it answers.
# Safe to run again: does nothing if the demo is already running. Logs: /tmp/alyassir-*.log
cd "$(dirname "$0")/../.."
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if [ "${1:-}" = "restart" ]; then
  pkill -f demo-server.mjs 2>/dev/null; pkill -f "vite" 2>/dev/null; sleep 2
fi
if curl -sf http://127.0.0.1:5173/api/health > /dev/null 2>&1; then
  echo "Alyassir is already running. Open the PORTS tab, port 5173."
  exit 0
fi
echo "Waiting for the database..."
until node -e "require('net').connect(5432,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; do sleep 1; done
if [ ! -f apps/server/dist/app.js ] || [ ! -d node_modules ] || [ ! -f apps/desktop/dist-demo/index.html ]; then
  echo "First start: preparing the program (a few minutes)..."
  bash tooling/demo/setup.sh || { echo "PREPARATION FAILED"; exit 1; }
fi
echo "Starting Alyassir..."
setsid nohup node apps/server/demo/demo-server.mjs < /dev/null > /tmp/alyassir-server.log 2>&1 &
setsid bash -c 'cd apps/desktop && exec env VITE_ADAPTER=web VITE_API_URL= ALYASSIR_DEMO_API=http://127.0.0.1:4300 pnpm exec vite preview --outDir dist-demo --port 5173 --strictPort --host ::' < /dev/null > /tmp/alyassir-ui.log 2>&1 &
for i in $(seq 1 120); do
  if curl -sf http://127.0.0.1:5173/api/health > /dev/null 2>&1; then
    echo ""
    echo "=============================================="
    echo " Alyassir is READY."
    echo " Open the PORTS tab, then the globe next to 5173."
    echo " Sign in: gerant / gerant123"
    echo "=============================================="
    exit 0
  fi
  sleep 2
done
echo "ALYASSIR DID NOT START. Details:"
tail -n 30 /tmp/alyassir-server.log
tail -n 20 /tmp/alyassir-ui.log
exit 1
