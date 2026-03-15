/**
 * Generates a shell script for installing the fleet node agent.
 *
 * Usage:
 *   curl -fsSL https://armada.example.com/install | sh -s -- --token <install-token>
 */
export function generateInstallScript(): string {
  const image = 'ghcr.io/coderage-labs/armada-node:latest';

  return `#!/bin/sh
set -e

# ── Armada Node Agent Installer ────────────────────────────────────

FLEET_NODE_IMAGE="${image}"
CONTAINER_NAME="armada-node-agent"
DATA_DIR="\${FLEET_DATA_DIR:-\$HOME/fleet-data}"

# Parse arguments
TOKEN=""
CONTROL_URL=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    --token) TOKEN="\$2"; shift 2 ;;
    --url)   CONTROL_URL="\$2"; shift 2 ;;
    --data)  DATA_DIR="\$2"; shift 2 ;;
    --name)  CONTAINER_NAME="\$2"; shift 2 ;;
    *) echo "Unknown option: \$1"; exit 1 ;;
  esac
done

if [ -z "\$TOKEN" ]; then
  echo "Error: --token is required"
  echo ""
  echo "Usage: curl -fsSL https://armada.example.com/install | sh -s -- --token <install-token>"
  echo ""
  echo "Get an install token from the Armada UI: Nodes → Add Node"
  exit 1
fi

# Default control URL — override with --url for self-hosted
CONTROL_URL="\${CONTROL_URL:-wss://armada.example.com/api/nodes/ws}"

echo "🚀 Installing Armada Node Agent"
echo "   Image:   \$FLEET_NODE_IMAGE"
echo "   Control: \$CONTROL_URL"
echo "   Data:    \$DATA_DIR"
echo ""

# Check Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ Docker is not installed. Install Docker first: https://docs.docker.com/get-docker/"
  exit 1
fi

# Create data directory
mkdir -p "\$DATA_DIR"
mkdir -p "\$DATA_DIR/node-credentials"

# Pull image
echo "📦 Pulling image..."
docker pull "\$FLEET_NODE_IMAGE"

# Stop existing container if running
if docker ps -a --format '{{.Names}}' | grep -q "^\$CONTAINER_NAME\$"; then
  echo "🔄 Removing existing container..."
  docker stop "\$CONTAINER_NAME" 2>/dev/null || true
  docker rm "\$CONTAINER_NAME" 2>/dev/null || true
fi

# Run
echo "🐳 Starting container..."
docker run -d \\
  --name "\$CONTAINER_NAME" \\
  --memory=256m --memory-swap=512m \\
  --cpus=0.5 \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v "\$DATA_DIR:/data" \\
  -v "\$DATA_DIR/node-credentials:/etc/fleet-node" \\
  -e "FLEET_CONTROL_URL=\$CONTROL_URL" \\
  -e "FLEET_NODE_TOKEN=\$TOKEN" \\
  -e "HOST_DATA_DIR=\$DATA_DIR" \\
  --restart unless-stopped \\
  "\$FLEET_NODE_IMAGE"

# Connect node agent to armada-net so it can reach instances via Docker DNS
docker network create armada-net 2>/dev/null || true
docker network connect armada-net "\$CONTAINER_NAME" 2>/dev/null || true

# Wait for connection
echo ""
echo "⏳ Waiting for connection..."
sleep 5

if docker logs "\$CONTAINER_NAME" 2>&1 | grep -q "Connected to control plane"; then
  echo "✅ Armada Node Agent connected successfully!"
else
  echo "⚠️  Container started but connection not confirmed yet."
  echo "   Check logs: docker logs \$CONTAINER_NAME"
fi

echo ""
echo "📋 Useful commands:"
echo "   Logs:    docker logs -f \$CONTAINER_NAME"
echo "   Stop:    docker stop \$CONTAINER_NAME"
echo "   Remove:  docker stop \$CONTAINER_NAME && docker rm \$CONTAINER_NAME"
`;
}
