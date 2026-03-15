/**
 * All event bus wiring lives here.
 * This is the single place to understand what events trigger what.
 *
 * Note: mutation.created was removed (#491) — rebuildSteps() is now called
 * directly from mutationService.stage() after linking the mutation to its
 * changeset. Direct call is simpler and easier to trace than event indirection.
 */

// No event wiring currently active.
// File retained as the canonical location for future event subscriptions.

export function initEventWiring(): void {
  // intentionally empty
}
