#!/bin/bash
# Package the plugin for distribution
set -e
cd "$(dirname "$0")/.."
npm run build -w @coderage-labs/armada-shared
npm run build -w @coderage-labs/armada-agent
cd packages/plugin
tar czf ../../armada-agent-plugin.tar.gz dist/ package.json openclaw.plugin.json
echo "✅ Plugin packaged: armada-agent-plugin.tar.gz"
