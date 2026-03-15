import { sql, like, desc } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { auditLog } from '../db/drizzle-schema.js';
import { randomUUID } from 'node:crypto';

export interface AuditEntry {
  id: string;
  timestamp: string;
  callerId?: string | null;
  callerName?: string | null;
  callerType: string;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  detail?: string | null;
  ipAddress?: string | null;
}

export const auditRepo = {
  insert(data: {
    callerId?: string | null;
    callerName?: string | null;
    callerType?: string;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    detail?: string | null;
    ipAddress?: string | null;
  }) {
    getDrizzle().insert(auditLog).values({
      id: randomUUID(),
      callerId: data.callerId || null,
      callerName: data.callerName || null,
      callerType: data.callerType || 'system',
      action: data.action,
      resourceType: data.resourceType || null,
      resourceId: data.resourceId || null,
      detail: data.detail || null,
      ipAddress: data.ipAddress || null,
    }).run();
  },

  query(params: {
    caller?: string;
    action?: string;
    resourceType?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): { entries: AuditEntry[]; total: number } {
    const conditions: any[] = [];
    
    if (params.caller) {
      conditions.push(sql`(${auditLog.callerId} = ${params.caller} OR ${auditLog.callerName} LIKE ${'%' + params.caller + '%'})`);
    }
    if (params.action) {
      conditions.push(like(auditLog.action, `%${params.action}%`));
    }
    if (params.resourceType) {
      conditions.push(sql`${auditLog.resourceType} = ${params.resourceType}`);
    }
    if (params.from) {
      conditions.push(sql`${auditLog.timestamp} >= ${params.from}`);
    }
    if (params.to) {
      conditions.push(sql`${auditLog.timestamp} <= ${params.to}`);
    }

    const whereClause = conditions.length > 0
      ? sql.join(conditions, sql` AND `)
      : undefined;

    const limit = Math.min(params.limit || 50, 200);
    const offset = params.offset || 0;

    const totalRow = whereClause
      ? getDrizzle().select({ count: sql<number>`COUNT(*)` }).from(auditLog).where(whereClause).get()
      : getDrizzle().select({ count: sql<number>`COUNT(*)` }).from(auditLog).get();
    const total = totalRow?.count ?? 0;

    const baseQuery = getDrizzle().select().from(auditLog);
    const rows = whereClause
      ? baseQuery.where(whereClause).orderBy(desc(auditLog.timestamp)).limit(limit).offset(offset).all()
      : baseQuery.orderBy(desc(auditLog.timestamp)).limit(limit).offset(offset).all();

    const entries: AuditEntry[] = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      callerId: r.callerId,
      callerName: r.callerName,
      callerType: r.callerType,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      detail: r.detail,
      ipAddress: r.ipAddress,
    }));

    return { entries, total };
  },
};
