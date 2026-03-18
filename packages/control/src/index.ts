import path from 'node:path';
import express from 'express';
import { getDb } from './db/index.js';
import { NodeManager } from './node-manager.js';
import { createApp, attachWebSocketUpgrade } from './app.js';
import { generateInstallScript } from './install-script.js';
import { nodesRepo, agentsRepo, migrateOwnerAssignments } from './repositories/index.js';
import { startHealthMonitor, stopHealthMonitor } from './services/health-monitor.js';
import { startWorkspaceRetention, stopWorkspaceRetention } from './services/workspace-retention.js';
import { startGithubSyncScheduler, stopGithubSyncScheduler } from './services/github-sync.js';
import { initTelegramBot, stopTelegramBot } from './services/telegram-bot.js';
import { initSlackBot } from './services/slack-bot.js';
import { initDiscordBot } from './services/discord-bot.js';
import { registerAllProviders } from './services/integrations/index.js';
import { startVersionChecker, stopVersionChecker } from './services/version-checker.js';
import { startStuckDetector, stopStuckDetector } from './services/stuck-detector.js';
import { pluginManager } from './services/plugin-manager.js';
import { providerApiKeyRepo } from './repositories/provider-api-key-repo.js';


const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';

// ── Startup ─────────────────────────────────────────────────────────

async function start() {
  // Init database
  console.log('📦 Initialising database…');
  getDb();

  // Seed default plugins
  pluginManager.seed();

  // Migrate any legacy plain-text API keys to encrypted form (idempotent)
  try {
    const migrated = providerApiKeyRepo.migrateEncryption();
    if (migrated > 0) {
      console.log(`🔐 Encrypted ${migrated} legacy API key(s) at rest`);
    }
  } catch (err: any) {
    console.warn('[startup] API key encryption migration failed (non-fatal):', err.message);
  }

  // Migrate legacy owner assignments to project_assignments table (#77)
  try {
    migrateOwnerAssignments();
  } catch (err: any) {
    console.warn('[startup] Owner assignment migration failed (non-fatal):', err.message);
  }

  // Register integration providers
  console.log('🔌 Registering integration providers…');
  registerAllProviders();

  // Set up NodeManager — tracks node IDs for WsNodeClient dispatch.
  // Nodes connect to the control plane via WebSocket (GET /api/nodes/ws).
  // No HTTP URL/token needed — communication goes through the WS command dispatcher.
  const nodeManager = new NodeManager();

  // Load all existing nodes into NodeManager by ID
  const existingNodes = nodesRepo.getAll();
  for (const node of existingNodes) {
    nodeManager.addNode(node.id);
  }
  console.log(`🔗 Loaded ${existingNodes.length} node(s) into NodeManager`);

  // ── Create Express app with all routes ──────────────────────────────
  const app = createApp({ nodeManager });

  // ── Meta: tool definitions for auto-discovery ───────────────────
  const { getToolDefs } = await import('./utils/tool-registry.js');
  const { optionalAuthMiddleware } = await import('./middleware/auth.js');
  const { getScopesForAgentRole } = await import('./utils/role-scopes.js');
  
  app.get('/api/meta/tools', optionalAuthMiddleware, (req, res) => {
    const allTools = getToolDefs();

    // Try to resolve agent role from X-Agent-Name header
    const agentName = req.headers['x-agent-name'] as string | undefined;
    if (agentName) {
      // Look up agent → get role
      const agent = agentsRepo.getAll().find(a => a.name === agentName);
      if (agent?.role) {
        const allowedScopes = getScopesForAgentRole(agent.role);
        if (!allowedScopes.includes('*')) {
          const filtered = allTools.filter(t => !t.scope || allowedScopes.includes(t.scope));
          return res.json(filtered);
        }
      }
    }

    // Fallback: existing scope-based filtering from caller auth
    const callerScopes: string[] = req.caller?.scopes ?? [];
    
    // No scopes = return all (backward compat: unauthenticated or operator without scope restriction)
    // Wildcard = return all
    if (callerScopes.length === 0 || callerScopes.includes('*')) {
      return res.json(allTools);
    }
    
    // Filter tools to only those the caller has scope for
    // Tools without a scope field are accessible to everyone
    const filtered = allTools.filter(t => !t.scope || callerScopes.includes(t.scope));
    res.json(filtered);
  });

  // ── Production: serve UI static files ─────────────────────────────

  if (process.env.NODE_ENV === 'production') {
    const uiDist = path.join(new URL('.', import.meta.url).pathname, '../../ui/dist');

    // Hashed assets (Vite fingerprinted) — cache forever
    app.use('/assets', express.static(path.join(uiDist, 'assets'), {
      maxAge: '1y',
      immutable: true,
    }));

    // Everything else (index.html, favicon, etc.) — always revalidate
    app.use(express.static(uiDist, {
      maxAge: 0,
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    }));

    // Node agent install script
    app.get('/install', (_req, res) => {
      res.type('text/plain').send(generateInstallScript());
    });

    // SPA fallback — serve index.html for non-API routes
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(path.join(uiDist, 'index.html'));
      }
    });
  }

  // ── Health monitor ─────────────────────────────────────────────────
  startHealthMonitor();

  // ── Workspace retention ─────────────────────────────────────────────
  startWorkspaceRetention();

  // ── Workflow dispatcher ─────────────────────────────────────────────
  const { initWorkflowDispatcher } = await import('./services/workflow-dispatcher.js');
  initWorkflowDispatcher();

  const { initConfigVersionTracker } = await import('./infrastructure/config-version-tracker.js');
  initConfigVersionTracker();

  const { initEventWiring } = await import('./infrastructure/event-wiring.js');
  initEventWiring();

  // ── GitHub sync scheduler ─────────────────────────────────────────
  if (process.env.GITHUB_TOKEN) {
    startGithubSyncScheduler();
    console.log('🔄 GitHub sync scheduler started (every 30m)');
  }

  // ── Stuck task detector ─────────────────────────────────────────────
  startStuckDetector();

  // ── Version checker ─────────────────────────────────────────────────
  startVersionChecker();

  // ── Telegram bot ───────────────────────────────────────────────────
  await initTelegramBot();

  // ── Slack bot ───────────────────────────────────────────────────────
  initSlackBot();

  // ── Discord bot ─────────────────────────────────────────────────────
  initDiscordBot();

  // Cleanup on shutdown
  const shutdown = async () => {
    stopHealthMonitor();
    stopWorkspaceRetention();
    stopStuckDetector();
    stopVersionChecker();
    stopGithubSyncScheduler();
    await stopTelegramBot();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const server = app.listen(PORT, HOST, () => {
    console.log(`🚀 Armada API running on http://${HOST}:${PORT}`);
  });

  // Attach WebSocket upgrade handler for node agent connections (GET /api/nodes/ws)
  attachWebSocketUpgrade(server);
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
