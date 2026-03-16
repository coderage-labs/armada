#!/bin/bash
set -e

ARMADA_VERSION="${ARMADA_VERSION:-latest}"
ARMADA_DIR="${ARMADA_DIR:-$HOME/.armada}"
REGISTRY="ghcr.io/coderage-labs"

# Parse args
MODE="full"  # full, control-only, node-only
NODE_TOKEN=""
CONTROL_URL=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --node-only) MODE="node-only"; shift ;;
    --control-only) MODE="control-only"; shift ;;
    --token) NODE_TOKEN="$2"; shift 2 ;;
    --control-url) CONTROL_URL="$2"; shift 2 ;;
    --dir) ARMADA_DIR="$2"; shift 2 ;;
    --version) ARMADA_VERSION="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Check prerequisites
for cmd in docker openssl; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "❌ Required command not found: $cmd"
    exit 1
  fi
done

if [ "$MODE" != "node-only" ]; then
  if ! docker compose version &> /dev/null; then
    echo "❌ docker compose (v2) is required"
    exit 1
  fi
fi

echo "🚀 Armada Installer"
echo "==========================="
echo "Mode: $MODE"
echo "Directory: $ARMADA_DIR"
echo "Version: $ARMADA_VERSION"
echo ""

mkdir -p "$ARMADA_DIR"

# Generate node token for .env (only needed for initial node registration)
if [ ! -f "$ARMADA_DIR/.env" ]; then
  ARMADA_NODE_TOKEN="${NODE_TOKEN:-}"
  cat > "$ARMADA_DIR/.env" << EOF
# Node agent install token — set this after registering a node in the UI
ARMADA_NODE_TOKEN=$ARMADA_NODE_TOKEN
EOF
  echo "✅ Created $ARMADA_DIR/.env"
else
  echo "ℹ️  Using existing $ARMADA_DIR/.env"
  source "$ARMADA_DIR/.env"
fi

# Create host data directory for node agent bind mount
DATA_DIR="$ARMADA_DIR/data"
mkdir -p "$DATA_DIR/node-credentials"

# Set default control URL if not provided
if [ -z "$CONTROL_URL" ]; then
  CONTROL_URL="__CONTROL_URL__"
fi

# ── Node-Only Mode: Standalone Docker Run ──────────────────────────────
if [ "$MODE" = "node-only" ]; then
  # Create network if it doesn't exist
  docker network create armada-net 2>/dev/null || true
  
  # Pull the node image
  docker pull "${REGISTRY}/armada-node:${ARMADA_VERSION}"
  
  # Stop and remove existing container if present
  docker stop armada-node 2>/dev/null || true
  docker rm armada-node 2>/dev/null || true
  
  # Run the node agent as a standalone container
  docker run -d \
    --name armada-node \
    --network armada-net \
    --restart unless-stopped \
    -p 8080:8080 \
    -e "ARMADA_NODE_TOKEN=${ARMADA_NODE_TOKEN:-}" \
    -e "ARMADA_CONTROL_URL=${CONTROL_URL}" \
    -e "HOST_DATA_DIR=${DATA_DIR}" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${DATA_DIR}:/data" \
    -v "${DATA_DIR}/node-credentials:/etc/armada-node" \
    "${REGISTRY}/armada-node:${ARMADA_VERSION}"
  
  echo ""
  echo "✅ Armada node is running!"
  echo ""
  echo "  🖥️  Node Agent: running on port 8080"
  echo "  📡 Control:    $CONTROL_URL"
  echo ""
  if [ -z "$ARMADA_NODE_TOKEN" ]; then
    echo "  ⚠️  No token set. Set ARMADA_NODE_TOKEN in $ARMADA_DIR/.env and restart:"
    echo "     docker restart armada-node"
  fi
  echo ""
  exit 0
fi

# ── Compose Mode: Control Plane (and optionally node) ──────────────────

# Write docker-compose.yml
cat > "$ARMADA_DIR/docker-compose.yml" << COMPOSE
services:
COMPOSE

if [ "$MODE" = "full" ] || [ "$MODE" = "control-only" ]; then
  cat >> "$ARMADA_DIR/docker-compose.yml" << COMPOSE
  control:
    image: ${REGISTRY}/armada:\${ARMADA_VERSION:-latest}
    container_name: armada-control
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - ARMADA_API_URL=http://armada-control:3001
      - ARMADA_DB_PATH=/data/armada.db
      - ARMADA_PLUGINS_PATH=/data/plugins
      - ARMADA_NETWORK_NAME=armada-net
    volumes:
      - armada-data:/data
      - armada-plugins:/data/plugins
    networks:
      - armada-net
    restart: unless-stopped
COMPOSE
fi

# Note: In full mode, we no longer include the node in compose.
# Users should run `curl https://fleet.../install | bash -s -- --node-only --token <token>`
# on each remote node instead.

# Volumes and networks
cat >> "$ARMADA_DIR/docker-compose.yml" << 'COMPOSE'

volumes:
  armada-data:
  armada-plugins:

networks:
  armada-net:
    name: armada-net
    driver: bridge
COMPOSE

echo ""
echo "✅ Configuration written to $ARMADA_DIR/"
echo ""

# Pull and start
cd "$ARMADA_DIR"
docker compose pull
docker compose up -d

echo ""
echo "✅ Armada control plane is running!"
echo ""
echo "  🌐 Dashboard:  http://localhost:3001"
echo ""
echo "  Next steps:"
echo "  1. Open the dashboard and complete the setup wizard"
echo "  2. Register a node (Nodes → Add Node → copy the install token)"
echo "  3. On each node machine, run:"
echo "     curl https://your-domain/install | bash -s -- --node-only --token <token>"
echo ""
