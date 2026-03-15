// ── Service barrel export ────────────────────────────────────────────
// Clean import path: import { agentManager, pluginManager } from '../services/index.js'

export { logActivity } from './activity-service.js';
export { logAudit, queryAudit } from './audit.js';
export type { AuditEntry, AuditQueryParams } from './audit.js';
export { agentManager } from './agent-manager.js';
export type { AgentManager } from './agent-manager.js';
export { instanceManager } from './instance-manager.js';
export type { InstanceManager } from './instance-manager.js';
export { pluginManager } from './plugin-manager.js';
export type { PluginManager } from './plugin-manager.js';
export { spawnManager } from './spawn-manager.js';
export type { SpawnManager, SpawnOptions } from './spawn-manager.js';
export { taskManager } from './task-manager.js';
export type { TaskManager } from './task-manager.js';
export { mutationService } from './mutation-service.js';
export type { MutationService, EntityType } from './mutation-service.js';
