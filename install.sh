#!/bin/bash
set -e

# ── Armada Node Agent Installer ──
# Installs a node agent that connects to the control plane.
# Control plane setup is a separate concern.
#
# The install token is baked into this script by the control plane.

ARMADA_VERSION="latest"
ARMADA_DIR="$HOME/.armada"
REGISTRY="ghcr.io/coderage-labs"
ARMADA_NODE_TOKEN="__NODE_TOKEN__"
CONTROL_URL="__CONTROL_URL__"

# Detect host architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64)
    PLATFORM="linux/amd64"
    ;;
  aarch64|arm64)
    PLATFORM="linux/arm64"
    ;;
  *)
    echo "❌ Unsupported architecture: $ARCH"
    echo "   Armada supports linux/amd64 and linux/arm64."
    exit 1
    ;;
esac

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --version)
      ARMADA_VERSION="$2"
      shift 2
      ;;
    --dir)
      ARMADA_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--version <version>] [--dir <path>]"
      exit 1
      ;;
  esac
done

# Check prerequisites
if ! command -v docker &> /dev/null; then
  echo "❌ Docker is required but not found"
  exit 1
fi

echo "🚀 Armada Node Installer"
echo "==========================="
echo "Version:      $ARMADA_VERSION"
echo "Architecture: $PLATFORM"
echo "Directory:    $ARMADA_DIR"
echo "Control:      $CONTROL_URL"
echo ""

# Create data directory for persistence
DATA_DIR="$ARMADA_DIR/data"
mkdir -p "$DATA_DIR/node-credentials"

# Create the armada-net network if it doesn't exist
docker network create armada-net 2>/dev/null || true

# Pull the node image
echo "📦 Pulling node image..."
docker pull "${REGISTRY}/armada-node:${ARMADA_VERSION}"

# Stop and remove existing container if present
docker stop armada-node 2>/dev/null || true
docker rm armada-node 2>/dev/null || true

# Run the node agent
echo "🚀 Starting node agent..."
docker run -d \
  --name armada-node \
  --network armada-net \
  --restart unless-stopped \
  -e "ARMADA_NODE_TOKEN=${ARMADA_NODE_TOKEN}" \
  -e "ARMADA_CONTROL_URL=${CONTROL_URL}" \
  -e "HOST_DATA_DIR=${DATA_DIR}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${DATA_DIR}:/data" \
  -v "${DATA_DIR}/node-credentials:/etc/armada-node" \
  "${REGISTRY}/armada-node:${ARMADA_VERSION}"

echo ""
echo "✅ Armada node is running!"
echo ""
echo "  📡 Control:    $CONTROL_URL"
echo "  🖥️  Container:  armada-node"
echo "  📂 Data:       $DATA_DIR"
echo ""
