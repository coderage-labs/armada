#!/bin/bash
set -e

FLEET_VERSION="${FLEET_VERSION:-latest}"
FLEET_DIR="${FLEET_DIR:-$HOME/.armada}"
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
    --dir) FLEET_DIR="$2"; shift 2 ;;
    --version) FLEET_VERSION="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "🚀 Armada Installer"
echo "==========================="
echo "Mode: $MODE"
echo "Directory: $FLEET_DIR"
echo "Version: $FLEET_VERSION"
echo ""

mkdir -p "$FLEET_DIR"

# Generate tokens
if [ ! -f "$FLEET_DIR/.env" ]; then
  FLEET_API_TOKEN=$(openssl rand -hex 32)
  NODE_AGENT_TOKEN="${NODE_TOKEN:-$(openssl rand -hex 32)}"
  cat > "$FLEET_DIR/.env" << EOF
FLEET_API_TOKEN=$FLEET_API_TOKEN
NODE_AGENT_TOKEN=$NODE_AGENT_TOKEN
EOF
  echo "✅ Generated tokens → $FLEET_DIR/.env"
else
  echo "ℹ️  Using existing tokens from $FLEET_DIR/.env"
  source "$FLEET_DIR/.env"
fi

# Write docker-compose.yml
if [ "$MODE" = "full" ] || [ "$MODE" = "control-only" ]; then
  cat > "$FLEET_DIR/docker-compose.yml" << 'COMPOSE'
version: '3.8'
services:
  control:
    image: ghcr.io/coderage-labs/armada:${FLEET_VERSION:-latest}
    container_name: armada-control
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - FLEET_API_TOKEN=${FLEET_API_TOKEN}
      - FLEET_DEFAULT_NODE_URL=http://armada-node:8080
      - FLEET_DEFAULT_NODE_TOKEN=${NODE_AGENT_TOKEN}
      - FLEET_DB_PATH=/data/fleet.db
      - FLEET_PLUGINS_PATH=/data/plugins
    volumes:
      - armada-data:/data
    networks:
      - armada
    restart: unless-stopped
COMPOSE
fi

if [ "$MODE" = "full" ] || [ "$MODE" = "node-only" ]; then
  if [ "$MODE" = "node-only" ]; then
    cat > "$FLEET_DIR/docker-compose.yml" << 'COMPOSE'
version: '3.8'
services:
COMPOSE
  fi

  cat >> "$FLEET_DIR/docker-compose.yml" << 'COMPOSE'
  armada-node:
    image: ghcr.io/coderage-labs/armada-node:${FLEET_VERSION:-latest}
    container_name: armada-node
    ports:
      - "8080:8080"
    environment:
      - NODE_AGENT_TOKEN=${NODE_AGENT_TOKEN}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - armada-volumes:/data/fleet/volumes
      - armada-plugins:/data/fleet/plugins:ro
    networks:
      - armada
      - armada
    restart: unless-stopped
COMPOSE

  cat >> "$FLEET_DIR/docker-compose.yml" << 'COMPOSE'

volumes:
  fleet-data:
  fleet-volumes:
  fleet-plugins:

networks:
  fleet:
    driver: bridge
  armada:
    driver: bridge
    name: armada
COMPOSE
fi

echo ""
echo "✅ Configuration written to $FLEET_DIR/"
echo ""

# Pull and start
cd "$FLEET_DIR"
docker compose pull
docker compose up -d

echo ""
echo "✅ Armada is running!"
echo ""
if [ "$MODE" = "full" ] || [ "$MODE" = "control-only" ]; then
  echo "  🌐 Dashboard:  http://localhost:3001"
  echo "  🔑 API Token:  $FLEET_API_TOKEN"
fi
if [ "$MODE" = "full" ] || [ "$MODE" = "node-only" ]; then
  echo "  🖥️  Node Agent: http://localhost:8080"
  echo "  🔑 Node Token: $NODE_AGENT_TOKEN"
fi
echo ""
echo "To install on another machine (node agent only):"
echo "  curl -fsSL https://raw.githubusercontent.com/coderage-labs/armada/main/install.sh | bash -s -- --node-only --token $NODE_AGENT_TOKEN"
echo ""
echo "To install the OpenClaw plugin:"
echo "  npm install @coderage-labs/armada-agent --registry https://npm.pkg.github.com"
echo ""
