// ── Lock Guard — reject mutations on locked targets ──

import type { Response, NextFunction } from 'express';
import { lockManager } from '../infrastructure/lock-manager.js';

/**
 * Express middleware factory: rejects mutations on locked targets.
 * Returns 409 Conflict with operation details.
 */
export function requireUnlocked(
  getTarget: (req: any) => { type: string; id: string } | null,
) {
  return (req: any, res: Response, next: NextFunction): void => {
    const target = getTarget(req);
    if (!target) {
      next();
      return;
    }

    const lock = lockManager.check(target.type, target.id);
    if (lock) {
      res.status(409).json({
        error: 'Target is locked by an active operation',
        operationId: lock.operationId,
        acquiredAt: lock.acquiredAt,
      });
      return;
    }

    // Also check global lock
    if (lockManager.isGlobalLocked()) {
      const globalLock = lockManager.check('global', 'armada');
      res.status(409).json({
        error: 'Armada is locked by a global operation',
        operationId: globalLock?.operationId,
        acquiredAt: globalLock?.acquiredAt,
      });
      return;
    }

    next();
  };
}
