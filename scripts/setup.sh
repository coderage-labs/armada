#!/bin/bash
set -e

echo "🚀 Armada Setup"
echo "======================="
echo ""

# Generate tokens if not set
if [ -z "$ARMADA_API_TOKEN" ]; then
  ARMADA_API_TOKEN=$(openssl rand -hex 32)
  echo "Generated Armada API token"
fi

if [ -z "$ARMADA_NODE_TOKEN" ]; then
  ARMADA_NODE_TOKEN=$(openssl rand -hex 32)
  echo "Generated Node Agent token"
fi

# Write .env file
cat > .env << EOF
ARMADA_API_TOKEN=$ARMADA_API_TOKEN
ARMADA_NODE_TOKEN=$ARMADA_NODE_TOKEN
EOF

echo ""
echo "Configuration written to .env"
echo ""
echo "Armada API Token: $ARMADA_API_TOKEN"
echo "Node Agent Token: $ARMADA_NODE_TOKEN"
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
echo "  ARMADA_API_TOKEN=$ARMADA_API_TOKEN"
echo ""
echo "To add a node agent on another machine:"
echo "  docker run -d \\"
echo "    -v /var/run/docker.sock:/var/run/docker.sock \\"
echo "    -e ARMADA_NODE_TOKEN=$ARMADA_NODE_TOKEN \\"
echo "    -p 8080:8080 \\"
echo "    --name armada-node \\"
echo "    armada-node"
echo ""
