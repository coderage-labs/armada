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

if ! docker compose version &> /dev/null; then
  echo "❌ docker compose (v2) is required"
  exit 1
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

# Create the shared network (instances will also join this)
docker network create armada-net 2>/dev/null || true

# Create host data directory for node agent bind mount
DATA_DIR="$ARMADA_DIR/data"
mkdir -p "$DATA_DIR/node-credentials"

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
    volumes:
      - armada-data:/data
      - armada-plugins:/data/plugins
    networks:
      - armada-net
    restart: unless-stopped
COMPOSE
fi

if [ "$MODE" = "full" ] || [ "$MODE" = "node-only" ]; then
  cat >> "$ARMADA_DIR/docker-compose.yml" << COMPOSE
  node:
    image: ${REGISTRY}/armada-node:\${ARMADA_VERSION:-latest}
    container_name: armada-node
    ports:
      - "8080:8080"
    environment:
      - ARMADA_NODE_TOKEN=\${ARMADA_NODE_TOKEN:-}
      - ARMADA_CONTROL_URL=${CONTROL_URL:-ws://armada-control:3001/api/nodes/ws}
      - HOST_DATA_DIR=${DATA_DIR}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DATA_DIR}:/data
      - ${DATA_DIR}/node-credentials:/etc/armada-node
      - armada-plugins:/data/armada/plugins:ro
    networks:
      - armada-net
    restart: unless-stopped
COMPOSE
fi

# Volumes and networks
cat >> "$ARMADA_DIR/docker-compose.yml" << 'COMPOSE'

volumes:
  armada-data:
  armada-plugins:

networks:
  armada-net:
    name: armada-net
    external: true
COMPOSE

echo ""
echo "✅ Configuration written to $ARMADA_DIR/"
echo ""

# Pull and start
cd "$ARMADA_DIR"
docker compose pull
docker compose up -d

echo ""
echo "✅ Armada is running!"
echo ""
if [ "$MODE" = "full" ] || [ "$MODE" = "control-only" ]; then
  echo "  🌐 Dashboard:  http://localhost:3001"
  echo ""
  echo "  Next steps:"
  echo "  1. Open the dashboard and complete the setup wizard"
  echo "  2. Register a node (Nodes → Add Node → copy the install token)"
  echo "  3. Set the token in $ARMADA_DIR/.env: ARMADA_NODE_TOKEN=<token>"
  echo "  4. Restart the node: cd $ARMADA_DIR && docker compose restart node"
  echo "  5. Create templates, instances, and agents from the dashboard"
fi
if [ "$MODE" = "node-only" ]; then
  echo "  🖥️  Node Agent: running on port 8080"
  echo "  📡 Control:    $CONTROL_URL"
fi
echo ""
