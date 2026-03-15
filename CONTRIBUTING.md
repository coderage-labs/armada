# Contributing to Armada

Thanks for your interest in contributing to Armada! This project is under active development.

## Getting Started

```bash
git clone https://github.com/coderage-labs/armada.git
cd armada
npm install
npm run build
```

## Development

```bash
# Run the control plane in development mode
cd packages/control && npm run dev

# Run the UI in development mode
cd packages/ui && npm run dev

# Run tests
npm test
```

## Project Structure

```
packages/
├── shared/      # Shared types and utilities
├── control/     # Control plane (API + UI server)
├── node/        # Node agent (runs on each host)
└── ui/          # React dashboard (Vite + shadcn/ui)

plugins/
├── shared/      # Shared plugin utilities
├── agent/       # Agent plugin (runs on managed instances)
└── control/     # Control plane plugin (optional)
```

## Pull Requests

1. Fork the repo and create a feature branch
2. Make your changes
3. Run `npm test` to ensure all tests pass
4. **Update documentation** — every feature or behavioural change must include doc updates (README, `docs/`, inline comments, spec files). If it changes how something works, the docs should reflect it before the PR is opened.
5. Open a PR against `main`

## Code Style

- TypeScript throughout
- ESM modules
- Conventional commits (Release Please manages versioning)

## Reporting Issues

Open an issue on GitHub. Include:
- Steps to reproduce
- Expected vs actual behavior
- Version info (node, Docker, Armada version)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
