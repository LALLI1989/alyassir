#!/usr/bin/env bash
# Codespaces only: starts the demo server and the interface (port 5173). Logs in /tmp/alyassir-*.log.
cd "$(dirname "$0")/../.."
until pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 || node -e "require('net').connect(5432,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; do sleep 1; done
nohup node apps/server/demo/demo-server.mjs > /tmp/alyassir-server.log 2>&1 &
cd apps/desktop
VITE_ADAPTER=web VITE_API_URL= ALYASSIR_DEMO_API=http://127.0.0.1:4300 nohup pnpm exec vite --port 5173 --strictPort --host 0.0.0.0 > /tmp/alyassir-ui.log 2>&1 &
echo "Alyassir is starting on port 5173"
