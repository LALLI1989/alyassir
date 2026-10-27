#!/usr/bin/env bash
# Codespaces only: install and build once, when the demo space is created.
set -e
cd "$(dirname "$0")/../.."
sudo corepack enable
corepack install
pnpm install --no-frozen-lockfile
pnpm turbo run build --filter=@alyassir/server...
