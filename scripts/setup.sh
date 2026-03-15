#!/bin/bash
set -e

echo "🚀 Armada Setup"
echo "======================="
echo ""

# Generate tokens if not set
if [ -z "$FLEET_API_TOKEN" ]; then
  FLEET_API_TOKEN=$(openssl rand -hex 32)
  echo "Generated Armada API token"
fi

if [ -z "$NODE_AGENT_TOKEN" ]; then
  NODE_AGENT_TOKEN=$(openssl rand -hex 32)
  echo "Generated Node Agent token"
fi

# Write .env file
cat > .env << EOF
FLEET_API_TOKEN=$FLEET_API_TOKEN
NODE_AGENT_TOKEN=$NODE_AGENT_TOKEN
EOF

echo ""
echo "Configuration written to .env"
echo ""
echo "Fleet API Token: $FLEET_API_TOKEN"
echo "Node Agent Token: $NODE_AGENT_TOKEN"
echo ""
echo "Starting Armada..."
docker compose up -d --build
echo ""
echo "✅ Armada is running!"
echo ""
echo "  Dashboard:  http://localhost:3001"
echo "  API:        http://localhost:3001/api"
echo "  Node Agent: http://localhost:8080"
echo ""
echo "To add this token to your Armada plugin config:"
echo "  FLEET_API_TOKEN=$FLEET_API_TOKEN"
echo ""
echo "To add a node agent on another machine:"
echo "  docker run -d \\"
echo "    -v /var/run/docker.sock:/var/run/docker.sock \\"
echo "    -e NODE_AGENT_TOKEN=$NODE_AGENT_TOKEN \\"
echo "    -p 8080:8080 \\"
echo "    --name armada-node \\"
echo "    armada-node"
echo ""
