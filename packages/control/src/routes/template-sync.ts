import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { templatesRepo, agentsRepo } from '../repositories/index.js';
import { generateOpenClawConfig } from '../templates/config-generator.js';
import { resolveVariables } from '../templates/resolver.js';
import { registerToolDef } from '../utils/tool-registry.js';
import type { NodeManager } from '../node-manager.js';
import type { Agent, Template, TemplateSkill } from '@coderage-labs/armada-shared';

registerToolDef({
  name: 'fleet_template_drift',
  description: 'Check if an agent\'s running config has drifted from its template. Shows differences.',
  method: 'GET', path: '/api/templates/:name/drift',
  parameters: [
    { name: 'name', type: 'string', description: 'Agent name to check', required: true },
  ],
});

registerToolDef({
  name: 'fleet_template_sync',
  description: 'Sync an agent\'s config back to match its template. Fixes drift.',
  method: 'POST', path: '/api/templates/:name/sync',
  parameters: [
    { name: 'name', type: 'string', description: 'Agent name to sync', required: true },
  ],
});

const PLUGINS_PATH = '/data/.openclaw/extensions';

// ── Diff helpers ────────────────────────────────────────────────────

interface ConfigDiff {
  key: string;
  expected: any;
  actual: any;
}

interface SkillsDiff {
  missing: string[];
  extra: string[];
}

interface FilesDiff {
  changed: string[];
}

interface AgentDrift {
  name: string;
  agentId: string;
  containerId: string;
  diffs: {
    config: ConfigDiff[];
    skills: SkillsDiff;
    files: FilesDiff;
  };
}

function diffConfigs(expected: any, actual: any, prefix = ''): ConfigDiff[] {
  const diffs: ConfigDiff[] = [];

  if (expected === null || expected === undefined || typeof expected !== 'object') {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      diffs.push({ key: prefix || 'root', expected, actual });
    }
    return diffs;
  }

  const allKeys = new Set([...Object.keys(expected), ...Object.keys(actual || {})]);
  for (const key of allKeys) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const expVal = expected[key];
    const actVal = actual?.[key];

    if (typeof expVal === 'object' && expVal !== null && !Array.isArray(expVal)) {
      diffs.push(...diffConfigs(expVal, actVal, fullKey));
    } else if (JSON.stringify(expVal) !== JSON.stringify(actVal)) {
      diffs.push({ key: fullKey, expected: expVal, actual: actVal });
    }
  }

  return diffs;
}

function diffSkills(templateSkills: TemplateSkill[], actualSkillNames: string[]): SkillsDiff {
  const expectedNames = templateSkills.map((s) => s.name);
  const missing = expectedNames.filter((n) => !actualSkillNames.includes(n));
  const extra = actualSkillNames.filter((n) => !expectedNames.includes(n));
  return { missing, extra };
}

// ── Route factory ───────────────────────────────────────────────────

export function createTemplateSyncRoutes(nodeManager: NodeManager): Router {
  const router = Router();

  async function computeDrift(template: Template): Promise<AgentDrift[]> {
    const allAgents = agentsRepo.getAll();
    const agents = allAgents.filter((a) => a.templateId === template.id);

    if (agents.length === 0) return [];

    const node = nodeManager.getDefaultNode();
    const results: AgentDrift[] = [];

    for (const agent of agents) {
      if (!agent.containerId) continue;

      const vars: Record<string, string> = {
        agent_name: agent.name,
        role: template.role,
        skills: template.skills,
      };

      // Read actual config first so we can extract tokens for comparison
      let actualConfig: any = {};
      try {
        actualConfig = await node.getContainerConfig(agent.containerId);
      } catch (err: any) {
        console.warn('[template-sync] getContainerConfig failed:', err.message);
      }

      // Generate expected config using the agent's actual tokens (avoids false drift)
      const { config: expectedConfig } = generateOpenClawConfig({
        template,
        agentName: agent.name,
        port: agent.port,
        pluginsPath: PLUGINS_PATH,
        gatewayToken: actualConfig?.gateway?.auth?.token,
        orgHooksToken: actualConfig?.hooks?.token,
      });

      // Compare configs, excluding agent-specific fields
      const expectedForDiff = JSON.parse(JSON.stringify(expectedConfig));
      const actualForDiff = JSON.parse(JSON.stringify(actualConfig));
      // These are unique per agent — never drift
      delete expectedForDiff?.gateway?.auth?.token;
      delete actualForDiff?.gateway?.auth?.token;
      delete expectedForDiff?.gateway?.remote?.token;
      delete actualForDiff?.gateway?.remote?.token;
      delete expectedForDiff?.hooks?.token;
      delete actualForDiff?.hooks?.token;

      const configDiffs = diffConfigs(expectedForDiff, actualForDiff);

      // Read actual skills
      let actualSkillNames: string[] = [];
      try {
        const skills = await node.listContainerSkills(agent.containerId);
        actualSkillNames = (skills as any[]).map((s: any) => s.name);
      } catch (err: any) {
        console.warn('[template-sync] listContainerSkills failed:', err.message);
      }

      const skillsDiff = diffSkills(template.skillsList || [], actualSkillNames);

      // Check files (SOUL.md, AGENTS.md)
      const changedFiles: string[] = [];

      if (template.soul) {
        try {
          const file = await node.getContainerFile(agent.containerId, '/data/.openclaw/workspace/SOUL.md');
          const actualContent = (file as any).content ?? '';
          const expectedContent = resolveVariables(template.soul, vars);
          if (actualContent.trim() !== expectedContent.trim()) {
            changedFiles.push('SOUL.md');
          }
        } catch (err: any) {
          console.warn('[template-sync] Failed to read SOUL.md:', err.message);
          changedFiles.push('SOUL.md');
        }
      }

      if (template.agents) {
        try {
          const file = await node.getContainerFile(agent.containerId, '/data/.openclaw/workspace/AGENTS.md');
          const actualContent = (file as any).content ?? '';
          const expectedContent = resolveVariables(template.agents, vars);
          if (actualContent.trim() !== expectedContent.trim()) {
            changedFiles.push('AGENTS.md');
          }
        } catch (err: any) {
          console.warn('[template-sync] Failed to read AGENTS.md:', err.message);
          changedFiles.push('AGENTS.md');
        }
      }

      const drift: AgentDrift = {
        name: agent.name,
        agentId: agent.id,
        containerId: agent.containerId,
        diffs: {
          config: configDiffs,
          skills: skillsDiff,
          files: { changed: changedFiles },
        },
      };

      results.push(drift);
    }

    return results;
  }

  // ── GET /api/templates/:name/drift ────────────────────────────────

  router.get('/:name/drift', async (req, res, next) => {
    try {
      const templates = templatesRepo.getAll();
      const template = templates.find((t) => t.name === req.params.name || t.id === req.params.name);
      if (!template) {
        res.status(404).json({ error: 'Template not found' });
        return;
      }

      const agents = await computeDrift(template);
      res.json({ template: template.name, agents });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/templates/:name/sync ────────────────────────────────

  router.post('/:name/sync', requireScope('templates:write'), async (req, res, next) => {
    try {
      const templates = templatesRepo.getAll();
      const template = templates.find((t) => t.name === req.params.name || t.id === req.params.name);
      if (!template) {
        res.status(404).json({ error: 'Template not found' });
        return;
      }

      // Dry run mode
      if (req.query['dry-run'] === 'true') {
        const agents = await computeDrift(template);
        res.json({ dryRun: true, template: template.name, agents });
        return;
      }

      const body = req.body || {};
      const targetAgentNames: string[] | undefined = body.agents;
      const force = body.force === true;
      const removeExtraSkills = body.removeExtraSkills === true;

      const node = nodeManager.getDefaultNode();
      const allAgents = agentsRepo.getAll();
      let agents = allAgents.filter((a) => a.templateId === template.id);

      // Filter to specific agents if requested
      if (targetAgentNames && targetAgentNames.length > 0) {
        agents = agents.filter((a) => targetAgentNames.includes(a.name));
      }

      const synced: Array<{
        name: string;
        changes: string[];
        restarted: boolean;
        recreated: boolean;
      }> = [];

      for (const agent of agents) {
        if (!agent.containerId) continue;

        const changes: string[] = [];
        let needsRestart = false;
        let needsRecreate = false;

        const vars: Record<string, string> = {
          agent_name: agent.name,
          role: template.role,
          skills: template.skills,
        };

        // 1. Generate and write config
        // Preserve existing gateway token
        let existingToken: string | undefined;
        try {
          const currentConfig = await node.getContainerConfig(agent.containerId);
          existingToken = (currentConfig as any)?.gateway?.auth?.token;
        } catch (err: any) {
          console.warn('[template-sync] Failed to read existing config token:', err.message);
        }

        const { config: newConfig } = generateOpenClawConfig({
          template,
          agentName: agent.name,
          port: agent.port,
          pluginsPath: PLUGINS_PATH,
          gatewayToken: existingToken,
        });

        try {
          await node.putContainerConfig(agent.containerId, newConfig);
          changes.push('config updated');
          needsRestart = true;
        } catch (err: any) {
          changes.push(`config write failed: ${err.message}`);
        }

        // 2. Write SOUL.md if template defines it
        if (template.soul) {
          const expectedSoul = resolveVariables(template.soul, vars);
          try {
            const file = await node.getContainerFile(agent.containerId, '/data/.openclaw/workspace/SOUL.md');
            if ((file as any).content?.trim() !== expectedSoul.trim()) {
              await node.putContainerFile(agent.containerId, '/data/.openclaw/workspace/SOUL.md', expectedSoul);
              changes.push('SOUL.md updated');
              needsRestart = true;
            }
          } catch (err: any) {
            console.warn('[template-sync] Failed to read SOUL.md for diff, writing fresh:', err.message);
            await node.putContainerFile(agent.containerId, '/data/.openclaw/workspace/SOUL.md', expectedSoul);
            changes.push('SOUL.md written');
            needsRestart = true;
          }
        }

        // 3. Write AGENTS.md if template defines it
        if (template.agents) {
          const expectedAgents = resolveVariables(template.agents, vars);
          try {
            const file = await node.getContainerFile(agent.containerId, '/data/.openclaw/workspace/AGENTS.md');
            if ((file as any).content?.trim() !== expectedAgents.trim()) {
              await node.putContainerFile(agent.containerId, '/data/.openclaw/workspace/AGENTS.md', expectedAgents);
              changes.push('AGENTS.md updated');
              needsRestart = true;
            }
          } catch (err: any) {
            console.warn('[template-sync] Failed to read AGENTS.md for diff, writing fresh:', err.message);
            await node.putContainerFile(agent.containerId, '/data/.openclaw/workspace/AGENTS.md', expectedAgents);
            changes.push('AGENTS.md written');
            needsRestart = true;
          }
        }

        // 4. Sync skills
        const templateSkillNames = (template.skillsList || []).map((s) => s.name);
        let actualSkillNames: string[] = [];
        try {
          const skills = await node.listContainerSkills(agent.containerId);
          actualSkillNames = (skills as any[]).map((s: any) => s.name);
        } catch (err: any) {
          console.warn('[template-sync] listContainerSkills failed:', err.message);
        }

        // Install missing skills
        const missingSkills = (template.skillsList || []).filter(
          (s) => !actualSkillNames.includes(s.name),
        );
        for (const skill of missingSkills) {
          try {
            await node.installContainerSkill(agent.containerId, {
              name: skill.name,
              source: skill.source || 'clawhub',
            });
            changes.push(`skill installed: ${skill.name}`);
          } catch (err: any) {
            changes.push(`skill install failed: ${skill.name} (${err.message})`);
          }
        }

        // Remove extra skills if requested
        if (removeExtraSkills) {
          const extraSkills = actualSkillNames.filter((n) => !templateSkillNames.includes(n));
          for (const name of extraSkills) {
            try {
              await node.removeContainerSkill(agent.containerId, name);
              changes.push(`skill removed: ${name}`);
            } catch (err: any) {
              changes.push(`skill remove failed: ${name} (${err.message})`);
            }
          }
        }

        // 5. Check if resource limits changed — need recreate
        try {
          const stats = await node.getContainerStats(agent.containerId);
          const currentMemLimit = (stats as any).memoryLimit || 0;
          const templateMem = parseMemoryToBytes(template.resources.memory);
          // If memory differs by more than 10%, need recreate
          if (templateMem && Math.abs(currentMemLimit - templateMem) / templateMem > 0.1) {
            needsRecreate = true;
          }
        } catch (err: any) {
          console.warn('[template-sync] getContainerStats failed:', err.message);
        }

        // 6. Apply: recreate or reload
        let recreated = false;
        let restarted = false;

        if (needsRecreate) {
          try {
            const result = await node.recreateContainer(agent.containerId, {
              image: template.image,
              resources: template.resources,
            });
            const newId = (result as any).containerId;
            if (newId) {
              agentsRepo.update(agent.id, { containerId: newId });
            }
            recreated = true;
            changes.push('container recreated (resource change)');
          } catch (err: any) {
            changes.push(`recreate failed: ${err.message}`);
            // Fall back to restart
            try {
              await node.reloadContainer(agent.containerId);
              restarted = true;
            } catch (err: any) { console.warn('[template-sync] reloadContainer fallback failed:', err.message); }
          }
        } else if (needsRestart) {
          try {
            await node.reloadContainer(agent.containerId);
            restarted = true;
            changes.push('config reloaded (SIGUSR1)');
          } catch (err: any) {
            changes.push(`reload failed: ${err.message}`);
          }
        }

        // 7. Update agent record
        agentsRepo.update(agent.id, {
          role: template.role,
          skills: template.skills,
          model: template.model,
        });

        synced.push({ name: agent.name, changes, restarted, recreated });
      }

      res.json({ synced });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// ── Utility ─────────────────────────────────────────────────────────

function parseMemoryToBytes(mem: string): number {
  const match = mem.match(/^(\d+(?:\.\d+)?)\s*([kmgt])?b?$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  const multipliers: Record<string, number> = {
    '': 1,
    k: 1024,
    m: 1024 ** 2,
    g: 1024 ** 3,
    t: 1024 ** 4,
  };
  return Math.floor(value * (multipliers[unit] ?? 1));
}
