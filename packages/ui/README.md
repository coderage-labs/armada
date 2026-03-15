# @coderage-labs/armada-ui

The Armada dashboard — a React SPA for managing your agent fleet.

## Stack

- **React 18** + TypeScript
- **Vite** for bundling
- **shadcn/ui** component library (Radix primitives + Tailwind CSS)
- **SSE** for real-time updates (single connection, no polling)
- Dark-first design with zinc palette

## Pages

- **Dashboard** — overview with agent health, recent activity, system stats
- **Agents** — manage agents, view health, generate avatars
- **Instances** — container lifecycle, config, session viewer
- **Nodes** — multi-node topology, container status, resource usage
- **Templates** — agent blueprints with role, model, tools, skills
- **Workflows** — DAG-based multi-step workflows with run history and collaboration threads
- **Projects** — kanban boards, GitHub integration, team management
- **Changesets** — staged config changes with diffs, apply/discard
- **Operations** — operational actions (restart, upgrade, nudge)
- **Settings** — avatar generation, notification channels, preferences
- **Users** — user management, credentials, linked accounts

## Development

```bash
npm run dev     # Vite dev server with HMR
npm run build   # Production build
```

## E2E Tests

Playwright smoke tests covering all pages:

```bash
npx playwright test
```

## Design Principles

- Data-dense, dark-first
- Cards for small collections, tables for large/growing lists
- `space-y-6` page wrappers, `p-5` cards
- Flat routes (no `/infrastructure/` prefixes)
- Inline pending mutation highlights via `usePendingStyle` hook
