import type { Server as HttpServer } from 'http';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { authMiddleware } from './middleware/auth.js';
import { pendingOverlayV2 as pendingOverlay } from './middleware/pending-overlay-v2.js';
import { NodeManager } from './node-manager.js';
import { handleNodeWsUpgrade } from './routes/node-ws.js';
import { createAgentRoutes } from './routes/agents.js';
import { createNodeRoutes } from './routes/nodes.js';
import { createSystemRoutes } from './routes/system.js';
import templateRoutes from './routes/templates.js';
import modelRoutes from './routes/models.js';
import providerRoutes from './routes/providers.js';
import { createTemplateSyncRoutes } from './routes/template-sync.js';
import pluginRoutes from './routes/plugins.js';
import deployRoutes from './routes/deploys.js';
import hierarchyRoutes from './routes/hierarchy.js';
import { createSkillRoutes } from './routes/skills.js';
import taskRoutes from './routes/tasks.js';
import activityRoutes from './routes/activity.js';
import projectRoutes from './routes/projects.js';
import assignmentRoutes from './routes/assignments.js';
import { createIntegrationRoutes, createProjectIntegrationRoutes } from './routes/integrations.js';
import proxyRoutes from './routes/proxy.js';
import prProxyRoutes from './routes/proxy-prs.js';
import webhookRoutes from './routes/webhooks.js';
import { webhooksInboundMgmtRouter, webhooksInboundReceiverRouter } from './routes/webhooks-inbound.js';
import { skillLibraryRoutes } from './routes/skill-library.js';
import { pluginLibraryRoutes } from './routes/plugin-library.js';
import fileRoutes from './routes/files.js';
import workflowRoutes from './routes/workflows.js';
import worktreeRoutes from './routes/worktrees.js';
import triageRoutes from './routes/triage.js';
import { createToolRoutes } from './routes/tools.js';
import userRoutes from './routes/users.js';
import { createCredentialRoutes } from './routes/credentials.js';
import instanceRoutes from './routes/instances.js';
import { eventsRoutes } from './routes/events.js';
import { operationsRoutes } from './routes/operations.js';
import { badgesRoutes } from './routes/badges.js';
import authRoutes from './routes/auth.js';
import { getOrigin } from './services/auth-service.js';
import auditRoutes from './routes/audit.js';
import settingsRoutes from './routes/settings.js';
import configRoutes from './routes/config.js';
import { changesetsRoutes } from './routes/changesets.js';
import { pendingMutationsRoutes } from './routes/pending-mutations.js';
import { draftRoutes } from './routes/draft.js';
import sessionEventsRouter from './routes/session-events.js';
import { usageRoutes, internalUsageRouter } from './routes/usage.js';
import { installScriptRoutes } from './routes/install-script.js';
import { notificationChannelsRoutes } from './routes/notification-channels.js';
import workflowArtifactRoutes from './routes/workflow-artifacts.js';
import projectReposRoutes from './routes/project-repos.js';
import { codebaseRouter } from './routes/codebase.js';
import { learningRouter } from './routes/learning.js';

export interface AppOptions {
  nodeManager: NodeManager;
  skipBackgroundServices?: boolean;
}

export function createApp(opts: AppOptions): express.Express {
  const app = express();
  const { nodeManager } = opts;

  // ── Middleware ───────────────────────────────────────────────────────
  app.use(cors({
    origin: (requestOrigin, callback) => {
      // Always allow localhost dev
      if (!requestOrigin || requestOrigin.startsWith('http://localhost')) {
        callback(null, true);
        return;
      }
      const allowed = getOrigin();
      callback(null, requestOrigin === allowed);
    },
    credentials: true,
  }));
  app.use(express.json());
  app.use(cookieParser());

  // ── Public inbound webhook receiver (no auth required) ──────────────
  app.use('/hooks', webhooksInboundReceiverRouter);

  // ── Public install script endpoint (no auth required) ────────────────
  app.use('/install', installScriptRoutes);

  // ── Control plane install script + compose template (no auth required) ──
  app.use('/api/install', installScriptRoutes);

  app.use('/api', authMiddleware);

  // ── Pending overlay — merge pending mutations into GET responses ──
  app.use('/api', pendingOverlay);

  // Store nodeManager on app for access in routes
  app.locals.nodeManager = nodeManager;

  // ── Routes ──────────────────────────────────────────────────────────
  app.use('/api', createSystemRoutes(nodeManager));
  app.use('/api/agents', createAgentRoutes(nodeManager));
  app.use('/api/nodes', createNodeRoutes(nodeManager));
  app.use('/api/templates', templateRoutes);
  app.use('/api/templates', createTemplateSyncRoutes(nodeManager));
  app.use('/api/skills/library', skillLibraryRoutes);
  app.use('/api/plugins/library', pluginLibraryRoutes);
  app.use('/api', createSkillRoutes(nodeManager));
  app.use('/api', pluginRoutes);
  app.use('/api', deployRoutes);
  app.use('/api/hierarchy', hierarchyRoutes);
  app.use('/api/tasks', taskRoutes);
  app.use('/api/activity', activityRoutes);
  app.use('/api/integrations', createIntegrationRoutes(nodeManager));
  app.use('/api/proxy/issues', proxyRoutes);
  app.use('/api/proxy/prs', prProxyRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/projects/:id/assignments', assignmentRoutes);
  app.use('/api/projects/:id/integrations', createProjectIntegrationRoutes(nodeManager));
  app.use('/api/projects/:id/repos2', projectReposRoutes);
  app.use('/api/codebase', codebaseRouter);
  app.use('/api/learning', learningRouter);
  app.use('/api/webhooks', webhookRoutes);
  app.use('/api/webhooks/inbound', webhooksInboundMgmtRouter);
  app.use('/api/tools', createToolRoutes(nodeManager));
  app.use('/api/files', fileRoutes);
  app.use('/api/workflows', workflowRoutes);
  app.use('/api/workflows/runs', workflowArtifactRoutes);
  app.use('/api/worktrees', worktreeRoutes);
  app.use('/api/triage', triageRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/models', modelRoutes);
  app.use('/api/providers', providerRoutes);
  app.use('/api/agents', createCredentialRoutes(nodeManager));
  app.use('/api/instances', instanceRoutes);
  app.use('/api/events', eventsRoutes);
  app.use('/api/operations', operationsRoutes);
  app.use('/api/badges', badgesRoutes);
  app.use('/api/notification-channels', notificationChannelsRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/config', configRoutes);
  app.use('/api/changesets', changesetsRoutes);
  app.use('/api/pending-mutations', pendingMutationsRoutes);
  app.use('/api/draft', draftRoutes);
  app.use('/api/internal/session-event', sessionEventsRouter);
  app.use('/api/internal/usage', internalUsageRouter);
  app.use('/api/usage', usageRoutes);

  // ── Error handler ───────────────────────────────────────────────────
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    const status = err.statusCode ?? err.status ?? 500;
    res.status(status).json({
      error: err.message ?? 'Internal server error',
    });
  });

  return app;
}

/**
 * Attach the node WebSocket upgrade handler to an existing HTTP server.
 *
 * Call this after `app.listen()` returns the http.Server:
 * ```ts
 * const server = app.listen(PORT, HOST, () => { ... });
 * attachWebSocketUpgrade(server);
 * ```
 */
export function attachWebSocketUpgrade(server: HttpServer): void {
  server.on('upgrade', handleNodeWsUpgrade);
}
