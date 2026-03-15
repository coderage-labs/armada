/**
 * armada-shared — Shared utilities for armada plugins.
 *
 * Extracted from armada-control and armada-agent to eliminate duplication.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
export declare const ARMADA_PENDING_SYM = "armada-session-pending";
export declare const ARMADA_COORD_CB_SYM = "armada-coordinator-callbacks";
/**
 * Get or create a globalThis-persisted Map that survives jiti re-evaluation.
 * Uses Symbol.for(symbolName) as the key on globalThis.
 */
export declare function getOrCreateGlobalMap<K, V>(symbolName: string): Map<K, V>;
/** Result from a sub-task, used in coordinator callbacks */
export interface SubTaskResult {
    taskId: string;
    targetName?: string;
    from?: string;
    text: string;
    error?: string;
    attachments?: string[];
    _isProgress?: boolean;
}
/** Parse JSON body from an incoming HTTP request */
export declare function readBody(req: IncomingMessage): Promise<any>;
/** Send a JSON response */
export declare function sendJson(res: ServerResponse, code: number, data: any): void;
/** Generate a armada task ID */
export declare function generateId(): string;
//# sourceMappingURL=index.d.ts.map