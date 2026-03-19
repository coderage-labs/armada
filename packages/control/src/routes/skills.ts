import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import type { AgentSkill, Skill } from '@coderage-labs/armada-shared';
import { agentsRepo, templatesRepo } from '../repositories/index.js';
import { registerToolDef } from '../utils/tool-registry.js';
import type { NodeManager } from '../node-manager.js';

registerToolDef({
  category: 'plugins',
  name: 'armada_skills',
  scope: 'plugins:read',
  description: 'List all available skills across armada nodes.',
  method: 'GET', path: '/api/skills',
  parameters: [],
});

registerToolDef({
  category: 'plugins',
  name: 'armada_agent_skills',
  scope: 'plugins:read',
  description: 'List skills installed on a specific agent.',
  method: 'GET', path: '/api/agents/:name/skills',
  parameters: [
    { name: 'name', type: 'string', description: 'Agent name', required: true },
  ],
});

registerToolDef({
  category: 'plugins',
  name: 'armada_agent_skill_install',
  description: 'Install a skill on a specific agent.',
  method: 'POST', path: '/api/agents/:name/skills',
  parameters: [
    { name: 'name', type: 'string', description: 'Agent name', required: true },
    { name: 'skill', type: 'string', description: 'Skill name to install', required: true },
  ],
  scope: 'skills:write',
});

registerToolDef({
  category: 'plugins',
  name: 'armada_agent_skill_remove',
  description: 'Remove a skill from a specific agent.',
  method: 'DELETE', path: '/api/agents/:name/skills/:skill',
  parameters: [
    { name: 'name', type: 'string', description: 'Agent name', required: true },
    { name: 'skill', type: 'string', description: 'Skill name to remove', required: true },
  ],
  scope: 'skills:write',
});

registerToolDef({
  category: 'plugins',
  name: 'armada_agent_skills_sync',
  description: 'Sync an agent\'s installed skills with its template. Installs missing, optionally removes extras.',
  method: 'POST', path: '/api/agents/:name/skills/sync',
  parameters: [
    { name: 'name', type: 'string', description: 'Agent name', required: true },
  ],
  scope: 'skills:write',
});

registerToolDef({
  category: 'plugins',
  name: 'armada_skill_install',
  description: 'Install a skill to the shared library on a node.',
  method: 'POST', path: '/api/skills/install',
  parameters: [
    { name: 'skill', type: 'string', description: 'Skill name or clawhub package to install', required: true },
  ],
  scope: 'skills:write',
});

registerToolDef({
  category: 'plugins',
  name: 'armada_skill_update',
  description: 'Update a skill in the shared library.',
  method: 'POST', path: '/api/skills/update',
  parameters: [
    { name: 'skill', type: 'string', description: 'Skill name to update', required: true },
  ],
  scope: 'skills:write',
});

export function createSkillRoutes(nodeManager: NodeManager): Router {
  const router = Router();

  // Helper: find agent by name
  function getAgentByName(name: string) {
    return agentsRepo.getAll().find((a) => a.name === name);
  }

  // Helper: get node client for an agent
  function getNodeForAgent(agent: { nodeId: string }) {
    return nodeManager.getNode(agent.nodeId) ?? nodeManager.getDefaultNode();
  }

  // GET /api/skills — aggregate skills from all nodes' shared libraries
  router.get('/skills', async (_req, res, next) => {
    try {
      const allSkills: Skill[] = [];
      for (const node of nodeManager.getAllNodes()) {
        try {
          const skills = (await node.listLibrarySkills()) as Skill[];
          allSkills.push(...skills);
        } catch (err: any) {
          console.warn('[skills] listLibrarySkills failed for node:', err.message);
        }
      }

      // Deduplicate by name
      const seen = new Map<string, Skill>();
      for (const s of allSkills) {
        if (!seen.has(s.name)) seen.set(s.name, s);
      }

      res.json(Array.from(seen.values()));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/agents/:name/skills — list skills for an agent, enriched with template info
  router.get('/agents/:name/skills', async (req, res, next) => {
    try {
      const agent = getAgentByName(req.params.name);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      if (!agent.containerId) {
        res.status(400).json({ error: 'Agent has no container' });
        return;
      }

      const node = getNodeForAgent(agent);
      const skills = (await node.listContainerSkills(agent.containerId)) as Skill[];

      // Get template skills for inTemplate enrichment
      let templateSkillNames = new Set<string>();
      if (agent.templateId) {
        const template = templatesRepo.getById(agent.templateId);
        if (template?.skillsList) {
          templateSkillNames = new Set(template.skillsList.map((s) => s.name));
        }
      }

      const enriched: AgentSkill[] = skills.map((s) => ({
        ...s,
        inTemplate: templateSkillNames.has(s.name),
      }));

      res.json(enriched);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/agents/:name/skills — install skill on specific agent
  router.post('/agents/:name/skills', requireScope('skills:write'), async (req, res, next) => {
    try {
      const agent = getAgentByName(req.params.name);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      if (!agent.containerId) {
        res.status(400).json({ error: 'Agent has no container' });
        return;
      }

      const { name: skillName, source = 'clawhub' } = req.body;
      if (!skillName) {
        res.status(400).json({ error: 'name is required' });
        return;
      }

      const node = getNodeForAgent(agent);
      const result = await node.installContainerSkill(agent.containerId, {
        name: skillName,
        source,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/agents/:name/skills/:skill — remove skill from agent
  router.delete('/agents/:name/skills/:skill', requireScope('skills:write'), async (req, res, next) => {
    try {
      const agent = getAgentByName(req.params.name);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      if (!agent.containerId) {
        res.status(400).json({ error: 'Agent has no container' });
        return;
      }

      const node = getNodeForAgent(agent);
      await node.removeContainerSkill(agent.containerId, req.params.skill);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // POST /api/agents/:name/skills/sync — sync agent skills with template
  router.post('/agents/:name/skills/sync', requireScope('skills:write'), async (req, res, next) => {
    try {
      const agent = getAgentByName(req.params.name);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      if (!agent.containerId) {
        res.status(400).json({ error: 'Agent has no container' });
        return;
      }
      if (!agent.templateId) {
        res.status(400).json({ error: 'Agent has no template' });
        return;
      }

      const template = templatesRepo.getById(agent.templateId);
      if (!template) {
        res.status(404).json({ error: 'Template not found' });
        return;
      }

      const node = getNodeForAgent(agent);
      const currentSkills = (await node.listContainerSkills(agent.containerId)) as Skill[];
      const currentNames = new Set(currentSkills.map((s) => s.name));
      const templateSkills = template.skillsList || [];
      const removeExtras = req.body?.removeExtras === true;

      const installed: string[] = [];
      const removed: string[] = [];
      const skipped: string[] = [];

      // Install missing
      for (const ts of templateSkills) {
        if (!currentNames.has(ts.name)) {
          try {
            await node.installContainerSkill(agent.containerId, {
              name: ts.name,
              source: ts.source,
            });
            installed.push(ts.name);
          } catch (err: any) {
            console.warn('[skills] installContainerSkill failed:', err.message);
            skipped.push(ts.name);
          }
        }
      }

      // Remove extras if requested
      if (removeExtras) {
        const templateNames = new Set(templateSkills.map((s) => s.name));
        for (const cs of currentSkills) {
          if (!templateNames.has(cs.name)) {
            try {
              await node.removeContainerSkill(agent.containerId, cs.name);
              removed.push(cs.name);
            } catch (err: any) {
              console.warn('[skills] removeContainerSkill failed:', err.message);
            }
          }
        }
      }

      res.json({ installed, removed, skipped });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/skills/install — install to shared library on a node
  router.post('/skills/install', requireScope('skills:write'), async (req, res, next) => {
    try {
      const { nodeId, name, source = 'clawhub' } = req.body;
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }

      const node = nodeId
        ? nodeManager.getNode(nodeId) ?? nodeManager.getDefaultNode()
        : nodeManager.getDefaultNode();

      const result = await node.installLibrarySkill({ name, source });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/skills/update — update a skill across all agents that have it
  router.post('/skills/update', requireScope('skills:write'), async (req, res, next) => {
    try {
      const { name, source = 'clawhub' } = req.body;
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }

      const agents = agentsRepo.getAll();
      const results: { agent: string; status: string }[] = [];

      for (const agent of agents) {
        if (!agent.containerId) continue;
        try {
          const node = getNodeForAgent(agent);
          const skills = (await node.listContainerSkills(agent.containerId)) as Skill[];
          if (skills.some((s) => s.name === name)) {
            // Remove old, install new
            await node.removeContainerSkill(agent.containerId, name);
            await node.installContainerSkill(agent.containerId, { name, source });
            results.push({ agent: agent.name, status: 'updated' });
          }
        } catch (e: any) {
          results.push({ agent: agent.name, status: `error: ${e.message}` });
        }
      }

      // Also update in shared library
      try {
        const defaultNode = nodeManager.getDefaultNode();
        await defaultNode.removeLibrarySkill(name);
        await defaultNode.installLibrarySkill({ name, source });
      } catch (err: any) {
        console.warn('[skills] Library skill update failed:', err.message);
      }

      res.json({ updated: results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createSkillRoutes;
