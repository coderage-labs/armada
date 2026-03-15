# AGENTS.md — Rules for AI Agents Working on Armada

## Documentation is Not Optional

**Every feature, bugfix, or behavioural change must include documentation updates.**

Before opening a PR, check:
- [ ] Does this change how an API endpoint works? → Update `docs/README.md`
- [ ] Does this add/change a config option? → Update `.env.example` and `docs/README.md`
- [ ] Does this change the event bus? → Update `packages/control/src/infrastructure/EVENT_MAP.md`
- [ ] Does this add a new spec or architecture concept? → Add or update the relevant `docs/*.md`
- [ ] Does this change the changeset pipeline? → Update `docs/UNIVERSAL-CHANGESET-SPEC.md`
- [ ] Does this affect plugin behaviour? → Update `docs/PLUGIN-GUIDE.md`
- [ ] Does this change the UI? → Update `docs/UI-DESIGN-SYSTEM.md` if layout/patterns change

**If you skip docs, the PR will be rejected.**

## Code Standards

- TypeScript, ESM modules throughout
- Tests required for new features — run `npm test` before committing
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- No `any` types unless absolutely unavoidable (and comment why)

## Architecture Rules

- **All config mutations go through the changeset pipeline** — never write directly to DB for config-affecting changes
- **Operational actions (restart, nudge, test) are direct** — they don't go through changesets
- **Routes are thin** — validate input, call service, format response
- **Services own business logic** — not routes, not repositories
- **Repositories are pure data access** — no business logic, no event emission
- **Events fire after DB writes** — never before, never instead of

## Project Structure

```
packages/
├── shared/      # Shared types and constants
├── control/     # Control plane (Fastify API + SQLite)
├── node/        # Node agent (Docker management)
└── ui/          # Dashboard (React + Vite + shadcn/ui)

plugins/
├── shared/      # Shared plugin types
├── agent/       # Plugin for managed agent instances
└── control/     # Plugin for the operator agent
```

## UI Rules

- Dark-first design, zinc palette
- Use shadcn/ui components — don't build custom equivalents
- Cards for small collections, tables for large/growing lists
- Page wrappers use `space-y-6`, cards use `p-5`
- SSE for real-time updates — no polling unless there's no alternative
- Always refetch after your own mutations (don't rely solely on SSE for same-client updates)

## Testing

- `npm test` runs vitest across all packages
- 680+ tests must pass before merge
- Add tests for new services, repositories, and API endpoints
- E2E tests in `packages/ui/e2e/` (Playwright)
- Integration tests in `packages/control/src/__tests__/integration/`
