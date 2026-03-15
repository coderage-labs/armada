/**
 * openclaw-fleet-shared — Shared utilities for fleet plugins.
 *
 * Extracted from armada-control and fleet-agent to eliminate duplication.
 */
// ── Symbol.for key constants ────────────────────────────────────────
export const FLEET_PENDING_SYM = 'openclaw-fleet-session-pending';
export const FLEET_COORD_CB_SYM = 'openclaw-fleet-coordinator-callbacks';
// ── GlobalThis Map helper ───────────────────────────────────────────
/**
 * Get or create a globalThis-persisted Map that survives jiti re-evaluation.
 * Uses Symbol.for(symbolName) as the key on globalThis.
 */
export function getOrCreateGlobalMap(symbolName) {
    const sym = Symbol.for(symbolName);
    if (!globalThis[sym]) {
        globalThis[sym] = new Map();
    }
    return globalThis[sym];
}
// ── HTTP helpers ────────────────────────────────────────────────────
/** Parse JSON body from an incoming HTTP request */
export function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString()));
            }
            catch {
                resolve({});
            }
        });
        req.on('error', reject);
    });
}
/** Send a JSON response */
export function sendJson(res, code, data) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
}
// ── ID generation ───────────────────────────────────────────────────
/** Generate a fleet task ID */
export function generateId() {
    return `ft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
//# sourceMappingURL=index.js.map