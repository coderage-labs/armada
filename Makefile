.PHONY: setup start stop restart logs build clean

setup:
	bash scripts/setup.sh

start:
	docker compose up -d

stop:
	docker compose down

restart:
	docker compose restart

logs:
	docker compose logs -f

logs-control:
	docker compose logs -f control

logs-node:
	docker compose logs -f node-agent

build:
	docker compose build

clean:
	docker compose down -v

dev:
	npm run dev

# Add a remote node agent
add-node:
	@read -p "Node URL (e.g. http://192.168.1.42:8080): " url; \
	read -p "Node Token: " token; \
	curl -s -X POST http://localhost:3001/api/nodes \
		-H "Authorization: Bearer $$(cat .env | grep ARMADA_API_TOKEN | cut -d= -f2)" \
		-H "Content-Type: application/json" \
		-d "{\"url\":\"$$url\",\"token\":\"$$token\"}" | jq .
