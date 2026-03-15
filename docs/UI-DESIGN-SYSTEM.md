# Armada — Design System

## Product Profile

- **Type**: DevOps armada management dashboard (SaaS, self-hosted)
- **Users**: Engineers managing AI agent armadas — technical, keyboard-heavy, dark-mode preference
- **Core need**: Monitor, configure, and control agents/nodes/instances in real-time
- **Density**: High — lots of entities, statuses, operations to track simultaneously

## Core Paradigm: The Changeset Pipeline

**Everything flows through: Stage → Review → Approve → Apply.**

This isn't a feature — it's the fundamental interaction model. Every config-affecting mutation (creating agents, changing models, updating templates, removing nodes) goes through the changeset pipeline. The UI must make this obvious at every level:

### The Two Modes

The user is always in one of two modes:
1. **Observing** — viewing live, applied state
2. **Staging** — making changes that are queued, not yet live

The UI must make it unambiguous which mode the user is in.

### How This Manifests

**Pending items render inline with real items.** When a user creates an agent, that agent appears in the agent list immediately — but with a visual badge/treatment showing it's staged, not live. Same for edits: the edited values show inline with a "pending" indicator. There is no separate "pending changes" page to go check.

**The bottom bar is the pipeline control centre.** It's not just a notification — it's how you review, approve, and apply your staged changes. It shows:
- Count of pending mutations
- The draft changeset with a diff summary
- Approve & Apply button (the primary action)
- Discard button (the escape hatch)
- Active operation progress when applying

**Every mutating action goes through staging.** Buttons like "Create Agent", "Delete Node", "Update Template" don't take immediate effect. They stage a mutation. The user sees the result inline (with badge), then applies when ready. This means:
- "Create" buttons should feel immediate (item appears) but the badge makes clear it's not live yet
- "Apply Changes" in the bottom bar is the real commit
- Discarding removes the inline items as if they never existed

**The diff is the review step.** Before applying, the user sees exactly what will change — a before/after snapshot comparison. This happens in the bottom bar's expanded view or in the changeset detail page.

### Visual Language for Pipeline States

| State | Visual Treatment |
|-------|-----------------|
| Live/applied | Normal rendering, no indicator |
| Staged (pending) | Small `PENDING` badge, subtle dashed border or muted accent background |
| Applying | Pulse animation on badge, progress in bottom bar |
| Failed | Red badge, error detail in bottom bar |
| Stale (conflict) | Warning badge, "Review required" |

### Pipeline-Aware Page Design

Every list/detail page that shows mutable entities must:
1. Fetch both real items AND pending mutations
2. Render pending items inline (identical styling + badge)
3. Show pending edits as inline value changes (not a separate panel)
4. Include a "staged" filter option so users can see only their pending changes
5. Never require the user to navigate away to see what they've staged

## Design Direction

**Style**: Data-Dense Dashboard + Dark Mode OLED + Minimalism
- Dense but readable — maximum info per viewport
- Dark-first (with light mode support)
- Clean lines, no decorative elements — every pixel earns its place
- Real-time feel — live status dots, streaming updates, operation progress

**Anti-patterns to avoid**:
- Luxury typography (serif fonts, calligraphic headings)
- Horizontal scroll journeys, parallax, storytelling patterns
- Neumorphism, glassmorphism (low contrast, bad for data density)
- Emoji as icons
- Animations >300ms (feels sluggish for a monitoring tool)
- Mock/placeholder data that pretends to be real

## Colour Palette

### Dark Mode (Primary)
| Role | Token | Hex | Usage |
|------|-------|-----|-------|
| Background | `--bg` | `#0A0A0B` | Page background |
| Surface | `--surface` | `#111113` | Cards, panels |
| Surface Raised | `--surface-raised` | `#1A1A1D` | Hover states, active items |
| Border | `--border` | `#27272A` | Card borders, dividers |
| Border Subtle | `--border-subtle` | `#1E1E21` | Inner dividers |
| Text Primary | `--text` | `#FAFAFA` | Headings, primary content |
| Text Secondary | `--text-secondary` | `#A1A1AA` | Labels, descriptions |
| Text Muted | `--text-muted` | `#71717A` | Timestamps, metadata |

### Light Mode
| Role | Token | Hex |
|------|-------|-----|
| Background | `--bg` | `#FFFFFF` |
| Surface | `--surface` | `#F9FAFB` |
| Surface Raised | `--surface-raised` | `#F3F4F6` |
| Border | `--border` | `#E5E7EB` |
| Text Primary | `--text` | `#111827` |
| Text Secondary | `--text-secondary` | `#6B7280` |
| Text Muted | `--text-muted` | `#9CA3AF` |

### Semantic Colours (both modes)
| Role | Token | Hex | Usage |
|------|-------|-----|-------|
| Success | `--success` | `#22C55E` | Online, completed, healthy |
| Warning | `--warning` | `#F59E0B` | Pending, degraded, attention |
| Error | `--error` | `#EF4444` | Failed, offline, critical |
| Info | `--info` | `#3B82F6` | Running, in-progress, links |
| Accent | `--accent` | `#8B5CF6` | Primary actions, brand element |
| Blocked | `--blocked` | `#F97316` | Blocked tasks, gated operations |

## Typography

**Font**: Inter (system-grade, excellent for data UIs)
- Fallback: `system-ui, -apple-system, sans-serif`
- Google Fonts: `https://fonts.google.com/share?selection.family=Inter:wght@400;500;600;700`

| Element | Weight | Size | Line Height | Tracking |
|---------|--------|------|-------------|----------|
| Page heading | 600 | 20px / 1.25rem | 28px | -0.01em |
| Section heading | 600 | 14px / 0.875rem | 20px | 0 |
| Body | 400 | 14px / 0.875rem | 20px | 0 |
| Small / Labels | 500 | 12px / 0.75rem | 16px | 0.02em |
| Mono (IDs, code) | 400 | 12px / 0.75rem | 16px | 0 |
| Table header | 500 | 12px / 0.75rem | 16px | 0.04em (uppercase) |

**Mono font**: `JetBrains Mono, ui-monospace, monospace` (for IDs, tokens, code blocks)

## Spacing Scale

Based on 4px grid:
| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Tight gaps (badge padding) |
| `--space-2` | 8px | Inline element gaps |
| `--space-3` | 12px | Card inner padding (compact) |
| `--space-4` | 16px | Card inner padding (standard) |
| `--space-5` | 20px | Card inner padding (comfortable) |
| `--space-6` | 24px | Section gaps, page padding |
| `--space-8` | 32px | Major section separation |

## Border Radius
| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 4px | Badges, small elements |
| `--radius-md` | 6px | Buttons, inputs |
| `--radius-lg` | 8px | Cards, dialogs |
| `--radius-xl` | 12px | Modals, large panels |

## Shadows (dark mode — subtle)
| Token | Value |
|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.3)` |
| `--shadow-md` | `0 4px 8px rgba(0,0,0,0.3)` |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,0.4)` |

## Component Specs

### Status Dot
- 8×8px circle, `border-radius: 50%`
- Colours map to semantic tokens: online=success, offline=error, pending=warning, running=info
- Pulse animation on "connecting" / "applying" states: `animation: pulse 2s ease-in-out infinite`
- Always paired with text label (colour is not the only indicator)

### Cards (small collections: nodes, instances, agents, templates, projects)
- Background: `--surface`
- Border: `1px solid var(--border)`
- Padding: `--space-5` (20px)
- Radius: `--radius-lg` (8px)
- Hover: `border-color: var(--accent)` with `transition: 150ms`
- `cursor: pointer` on all clickable cards
- Grid: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`

### Tables (large/growing lists: tasks, operations, changesets, activity, logs)
- Header: uppercase, `--text-muted`, `--space-3` padding
- Row height: 40px minimum
- Row hover: `--surface-raised`
- Border between rows: `--border-subtle`
- Sortable columns: chevron indicator
- Mobile: wrap in `overflow-x-auto`, hide non-essential columns with `hidden sm:table-cell`

### Buttons
| Variant | Background | Text | Border |
|---------|-----------|------|--------|
| Primary | `--accent` | white | none |
| Secondary | `--surface-raised` | `--text` | `--border` |
| Outline | transparent | `--text-secondary` | `--border` |
| Danger | `--error` | white | none |
| Ghost | transparent | `--text-secondary` | none |

- Height: 36px (default), 32px (sm), 40px (lg)
- Radius: `--radius-md`
- `cursor: pointer` always
- Hover: darken/lighten 10%
- Transition: `150ms ease`
- Focus: `2px solid var(--accent)` ring

### Dialogs / Modals
- Overlay: `rgba(0,0,0,0.6)` with `backdrop-filter: blur(4px)`
- Max width: `32rem` (sm), `42rem` (md), `56rem` (lg)
- Max height: `90vh` with internal scroll
- Radius: `--radius-xl`
- Close button: always visible top-right (X icon)
- Mobile: nearly full-width with `mx-4` margin

### Bottom Bar (Pipeline Control Centre)

The bottom bar is the primary interface for the changeset pipeline — the most important UI element after the content itself.

**Visibility rules:**
- Hidden when zero pending mutations AND no active operations (clean slate)
- Collapsed bar when mutations are pending (always visible — user must know changes are staged)
- Expanded when user clicks to review, or when an apply operation is running

**Collapsed state** (single row, ~48px):
- Left: changeset status icon + "N changes staged" count
- Right: "Review & Apply" primary button + "Discard" ghost button
- Background: `--surface` with `border-top: 2px solid var(--accent)` (stronger than normal borders — this is important)

**Expanded state** (~300px max, scrollable):
- Mutation list grouped by entity type (agents, nodes, instances, etc.)
- Each mutation: entity name + operation (create/update/delete) + brief diff
- Diff view: before → after for each changed field
- Step plan: what operations will execute on apply (with dependency graph if complex)
- Operation progress: running steps with status dots and duration
- Approve & Apply button (primary, prominent)
- Discard button (danger/ghost)

**During apply:**
- Bar stays expanded, auto-scrolls to show operation progress
- Each step transitions: pending → running → completed/failed
- On completion: success toast + bar collapses after 3s
- On failure: bar stays expanded showing error detail + retry option

**Keyboard shortcut**: `Cmd/Ctrl + Enter` to approve & apply from anywhere

### Sidebar
- Width: 240px (expanded), 56px (collapsed)
- Background: `--bg` or slightly darker
- Items: icon + label inline (`flex items-center gap-3`)
- Active item: `--surface-raised` background + `--accent` left border (3px)
- Hover: `--surface-raised`
- Groups: visual labels (uppercase, `--text-muted`, `--space-2` padding) — no route prefixes
- Collapse toggle at bottom
- Tooltips on collapsed mode only

### Empty States
- Centered icon (muted, 48px) + heading + description + action button
- Never show an empty table with just headers
- Never show "No data" without context

### Loading States
- Skeleton shimmer for cards and tables (not spinners)
- Keep layout stable — skeletons match final content dimensions

### Error States
- Inline error messages (red text below the relevant field)
- Toast notifications for transient errors (auto-dismiss 5s)
- Error boundary fallback for page-level crashes

## Layout

```
┌─────────────────────────────────────────────────────┐
│ TopBar (h-14): hamburger (mobile) | breadcrumb | user │
├──────┬──────────────────────────────────────────────┤
│      │                                              │
│  S   │  Main Content (p-6, space-y-6)              │
│  i   │                                              │
│  d   │  ┌─ Page Heading ──────────────────────┐    │
│  e   │  │ Title + Description + Actions        │    │
│  b   │  └──────────────────────────────────────┘    │
│  a   │                                              │
│  r   │  ┌─ Content ───────────────────────────┐    │
│      │  │ Cards / Tables / Detail              │    │
│  240 │  │                                      │    │
│  px  │  └──────────────────────────────────────┘    │
│      │                                              │
├──────┴──────────────────────────────────────────────┤
│ BottomBar (conditional): staging panel / operations  │
└─────────────────────────────────────────────────────┘
```

- Main content: `flex-1 overflow-auto p-6`
- Page wrapper: `<div className="space-y-6">`
- Layout provides outer padding — pages must NOT add their own
- Card padding: `p-5` across all cards

## Responsive Breakpoints
| Breakpoint | Width | Behaviour |
|-----------|-------|-----------|
| Mobile | < 640px | Sidebar hidden (hamburger), single column, tables scroll |
| Tablet | 640-1024px | Sidebar collapsed (icons only), 2-column grid |
| Desktop | > 1024px | Sidebar expanded, 3-column grid, full tables |

## Icons
- **Library**: Lucide React (consistent, MIT, tree-shakable)
- **Size**: 16px in tables/buttons, 20px in navigation, 48px in empty states
- **Never use emoji as icons**

## Transitions
- Default: `150ms ease` (hovers, focus)
- Panels/modals: `200ms ease` (open/close)
- Data updates: `300ms ease` (number changes, status transitions)
- `prefers-reduced-motion`: disable all non-essential animations

## Pre-Delivery Checklist
- [ ] No emojis as icons (use Lucide SVGs)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150ms)
- [ ] All text meets 4.5:1 contrast ratio minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive at: 375px, 768px, 1024px, 1440px
- [ ] No horizontal scroll on mobile
- [ ] Empty states for every list/table
- [ ] Loading skeletons match final layout
- [ ] Error states handled (inline + toast + boundary)
- [ ] All dialogs scrollable on mobile
- [ ] Bottom bar appears when mutations pending
- [ ] Every user flow from UI-FUNCTIONAL-SPEC.md works
