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

echo "🚀 Armada Installer"
echo "==========================="
echo "Mode: $MODE"
echo "Directory: $ARMADA_DIR"
echo "Version: $ARMADA_VERSION"
echo ""

mkdir -p "$ARMADA_DIR"

# Generate tokens
if [ ! -f "$ARMADA_DIR/.env" ]; then
  ARMADA_API_TOKEN=$(openssl rand -hex 32)
  ARMADA_NODE_TOKEN="${NODE_TOKEN:-$(openssl rand -hex 32)}"
  cat > "$ARMADA_DIR/.env" << EOF
ARMADA_API_TOKEN=$ARMADA_API_TOKEN
ARMADA_NODE_TOKEN=$ARMADA_NODE_TOKEN
EOF
  echo "✅ Generated tokens → $ARMADA_DIR/.env"
else
  echo "ℹ️  Using existing tokens from $ARMADA_DIR/.env"
  source "$ARMADA_DIR/.env"
fi

# Write docker-compose.yml
if [ "$MODE" = "full" ] || [ "$MODE" = "control-only" ]; then
  cat > "$ARMADA_DIR/docker-compose.yml" << 'COMPOSE'
version: '3.8'
services:
  control:
    image: ghcr.io/coderage-labs/armada:${ARMADA_VERSION:-latest}
    container_name: armada-control
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - ARMADA_API_TOKEN=${ARMADA_API_TOKEN}
      - ARMADA_DEFAULT_NODE_URL=http://armada-node:8080
      - ARMADA_DEFAULT_NODE_TOKEN=${ARMADA_NODE_TOKEN}
      - ARMADA_DB_PATH=/data/armada.db
      - ARMADA_PLUGINS_PATH=/data/plugins
    volumes:
      - armada-data:/data
    networks:
      - armada
    restart: unless-stopped
COMPOSE
fi

if [ "$MODE" = "full" ] || [ "$MODE" = "node-only" ]; then
  if [ "$MODE" = "node-only" ]; then
    cat > "$ARMADA_DIR/docker-compose.yml" << 'COMPOSE'
version: '3.8'
services:
COMPOSE
  fi

  cat >> "$ARMADA_DIR/docker-compose.yml" << 'COMPOSE'
  armada-node:
    image: ghcr.io/coderage-labs/armada-node:${ARMADA_VERSION:-latest}
    container_name: armada-node
    ports:
      - "8080:8080"
    environment:
      - ARMADA_NODE_TOKEN=${ARMADA_NODE_TOKEN}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - armada-volumes:/data/armada/volumes
      - armada-plugins:/data/armada/plugins:ro
    networks:
      - armada
      - armada
    restart: unless-stopped
COMPOSE

  cat >> "$ARMADA_DIR/docker-compose.yml" << 'COMPOSE'

volumes:
  armada-data:
  armada-volumes:
  armada-plugins:

networks:
  armada:
    driver: bridge
  armada:
    driver: bridge
    name: armada
COMPOSE
fi

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
  echo "  🔑 API Token:  $ARMADA_API_TOKEN"
fi
if [ "$MODE" = "full" ] || [ "$MODE" = "node-only" ]; then
  echo "  🖥️  Node Agent: http://localhost:8080"
  echo "  🔑 Node Token: $ARMADA_NODE_TOKEN"
fi
echo ""
echo "To install on another machine (node agent only):"
echo "  curl -fsSL https://raw.githubusercontent.com/coderage-labs/armada/main/install.sh | bash -s -- --node-only --token $ARMADA_NODE_TOKEN"
echo ""
echo "To install the OpenClaw plugin:"
echo "  npm install @coderage-labs/armada-agent --registry https://npm.pkg.github.com"
echo ""
