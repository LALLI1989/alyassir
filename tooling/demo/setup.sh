#!/usr/bin/env bash
# Codespaces only: install and build once, when the demo space is created.
set -e
cd "$(dirname "$0")/../.."
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
sudo corepack enable
corepack install
# Keep the package store outside the project folder (it is not part of the code).
pnpm config set store-dir "$HOME/.pnpm-store"
pnpm install --no-frozen-lockfile
git checkout -- pnpm-lock.yaml 2>/dev/null || true
pnpm turbo run build --filter=@alyassir/server...
