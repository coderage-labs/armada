/**
 * Git credential endpoints for agents.
 *
 * GET  /api/agents/:name/credentials       — returns real tokens (internal, node-agent only)
 * POST /api/agents/:name/credentials/sync   — triggers credential sync via node agent
 */

import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { agentsRepo, templatesRepo, nodesRepo } from '../repositories/index.js';
import { projectsRepo } from '../repositories/index.js';
import { integrationsRepo } from '../services/integrations/integrations-repo.js';
import { projectIntegrationsRepo } from '../services/integrations/project-integrations-repo.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { syncAgentCredentials } from '../services/credential-sync.js';
import type { NodeManager } from '../node-manager.js';

interface GitCredential {
  host: string;
  paths: string[];
  protocol: string;
  username: string;
  password: string;
}

/** Map provider name to { username, password } from authConfig */
function mapProviderAuth(provider: string, authConfig: Record<string, any>): { username: string; password: string } {
  const token = authConfig.token || authConfig.accessToken || '';
  switch (provider) {
    case 'github':
      return { username: 'x-access-token', password: token };
    case 'bitbucket':
      return { username: authConfig.email || 'oauth2', password: token };
    case 'atlassian':
      return { username: authConfig.email || 'oauth2', password: token };
    default:
      return { username: 'oauth2', password: token };
  }
}

/** Map provider name to default host */
function providerHost(provider: string, authConfig: Record<string, any>): string {
  if (authConfig.host) return authConfig.host;
  switch (provider) {
    case 'github':    return 'github.com';
    case 'bitbucket': return 'bitbucket.org';
    case 'atlassian': return 'bitbucket.org';
    default:          return 'github.com';
  }
}

/** Extract repo paths from a project-integration config + project repositories */
function extractRepoPaths(
  piConfig: Record<string, any>,
  projectRepos: Array<{ url: string }>,
  host: string,
): string[] {
  const paths: string[] = [];

  // From project-integration config (e.g., { repos: ["owner/repo"] })
  if (piConfig.repos && Array.isArray(piConfig.repos)) {
    paths.push(...piConfig.repos);
  }

  // From project repositories — extract owner/repo from URL
  for (const repo of projectRepos) {
    const repoPath = extractRepoPath(repo.url, host);
    if (repoPath && !paths.includes(repoPath)) {
      paths.push(repoPath);
    }
  }

  return paths;
}

/** Extract 'owner/repo' from a URL or shorthand */
function extractRepoPath(url: string, _host: string): string | null {
  // Handle "owner/repo" shorthand
  if (/^[^/]+\/[^/]+$/.test(url)) return url;

  // Handle full URLs like https://github.com/owner/repo
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    const parts = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  } catch (err: any) {
    console.warn('[credentials] Failed to parse repo URL:', err.message);
  }
  return null;
}

export function createCredentialRoutes(nodeManager: NodeManager): Router {
  const router = Router();

  // ── Tool definitions ──────────────────────────────────────────────

  registerToolDef({
    name: 'armada_agent_credentials_sync',
    description: 'Trigger git credential sync for a agent. Pushes VCS tokens from integrations to the agent container.',
    method: 'POST',
    path: '/api/agents/:name/credentials/sync',
    parameters: [
      { name: 'name', type: 'string', description: 'Agent name', required: true },
    ],
  });

  // ── GET /api/agents/:name/credentials ─────────────────────────────
  // Internal endpoint — returns real tokens for the node agent to write
  // to the agent's credential file.

  router.get('/:name/credentials', async (req, res, next) => {
    try {
      const { name } = req.params;

      // Find agent
      const agents = agentsRepo.getAll();
      const agent = agents.find(a => a.name === name);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      // Get agent's template
      const template = agent.templateId ? templatesRepo.getById(agent.templateId) : null;
      const projectNames: string[] = (template as any)?.projects ?? [];

      if (projectNames.length === 0) {
        res.json({ git: [] });
        return;
      }

      // Collect credentials grouped by integration ID
      const credByIntegration = new Map<string, GitCredential>();

      for (const projName of projectNames) {
        const project = projectsRepo.getByName(projName);
        if (!project) continue;

        // Get VCS integrations for this project
        const piConfigs = projectIntegrationsRepo.getByProject(project.id);
        for (const pi of piConfigs) {
          if (pi.capability !== 'vcs' || !pi.enabled) continue;

          const integration = integrationsRepo.getById(pi.integrationId);
          if (!integration || integration.status !== 'active') continue;

          const host = providerHost(integration.provider, integration.authConfig);
          const { username, password } = mapProviderAuth(integration.provider, integration.authConfig);

          if (!password) continue; // no token, skip

          const key = integration.id;
          const existing = credByIntegration.get(key);

          const repoPaths = extractRepoPaths(
            pi.config || {},
            project.repositories || [],
            host,
          );

          if (existing) {
            // Merge paths
            for (const p of repoPaths) {
              if (!existing.paths.includes(p)) {
                existing.paths.push(p);
              }
            }
          } else {
            credByIntegration.set(key, {
              host,
              paths: repoPaths.length > 0 ? repoPaths : ['*'],
              protocol: 'https',
              username,
              password,
            });
          }
        }
      }

      res.json({ git: Array.from(credByIntegration.values()) });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/agents/:name/credentials/sync ──────────────────────
  // Manual trigger — calls the node agent to sync credentials.

  router.post('/:name/credentials/sync', requireScope('agents:write'), async (req, res, next) => {
    try {
      const { name } = req.params;

      const agents = agentsRepo.getAll();
      const agent = agents.find(a => a.name === name);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      await syncAgentCredentials(name, nodeManager);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createCredentialRoutes;
