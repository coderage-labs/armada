import type { Request } from 'express';
import { auditRepo } from '../repositories/audit-repo.js';
export type { AuditEntry } from '../repositories/audit-repo.js';

export function logAudit(
  req: Request,
  action: string,
  resourceType?: string,
  resourceId?: string,
  detail?: Record<string, any>,
): void {
  try {
    const caller = req.caller;
    auditRepo.insert({
      callerId: caller?.id || null,
      callerName: caller?.displayName || caller?.name || null,
      callerType: caller?.type || 'system',
      action,
      resourceType: resourceType || null,
      resourceId: resourceId || null,
      detail: detail ? JSON.stringify(detail) : null,
      ipAddress: req.ip || req.socket.remoteAddress || null,
    });
  } catch (err) {
    console.error('[audit] Failed to log:', err);
  }
}

export interface AuditQueryParams {
  caller?: string;
  action?: string;
  resourceType?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function queryAudit(params: AuditQueryParams) {
  return auditRepo.query(params);
}
