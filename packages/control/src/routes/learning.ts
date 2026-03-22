/**
 * Learning system API routes — reviews, scoring, lessons, conventions.
 * Phase 1+2 of #185.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getDrizzle } from '../db/drizzle.js';
import { reviewRecords, agentLessons, projectConventions, agentScores } from '../db/drizzle-schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { requireScope } from '../middleware/scopes.js';
import { registerToolDef } from '../utils/tool-registry.js';

export const learningRouter = Router();

// ── Tool definitions ────────────────────────────────────────────────

const LEARNING_TOOLS = [
  { category: 'learning', scope: 'workflows:write', name: 'armada_review_submit', description: 'Submit a structured review for a workflow step. Includes score (1-5), result (approved/rejected), and feedback.', method: 'POST', path: '/api/learning/reviews',
    parameters: [
      { name: 'runId', type: 'string', description: 'Workflow run ID', required: true },
      { name: 'stepId', type: 'string', description: 'Step ID being reviewed', required: true },
      { name: 'score', type: 'number', description: 'Quality score 1-5 (1=poor, 5=excellent)', required: true },
      { name: 'result', type: 'string', description: 'approved or rejected', required: true },
      { name: 'feedback', type: 'string', description: 'Detailed feedback text' },
      { name: 'issues', type: 'string', description: 'JSON array of specific issues found' },
    ] },
  { category: 'learning', scope: 'workflows:read', name: 'armada_agent_score', description: 'Get an agent\'s quality scores and review history.', method: 'POST', path: '/api/learning/agent-score',
    parameters: [
      { name: 'agent', type: 'string', description: 'Agent name', required: true },
    ] },
  { category: 'learning', scope: 'workflows:read', name: 'armada_agent_lessons', description: 'Get an agent\'s active lessons (things it should remember from past reviews).', method: 'POST', path: '/api/learning/agent-lessons',
    parameters: [
      { name: 'agent', type: 'string', description: 'Agent name', required: true },
      { name: 'projectId', type: 'string', description: 'Filter by project' },
    ] },
  { category: 'learning', scope: 'projects:read', name: 'armada_project_conventions', description: 'Get a project\'s conventions (patterns extracted from review feedback).', method: 'POST', path: '/api/learning/conventions',
    parameters: [
      { name: 'projectId', type: 'string', description: 'Project ID', required: true },
    ] },
  { category: 'learning', scope: 'projects:write', name: 'armada_conventions_extract', description: 'Manually trigger convention extraction for a project. Analyzes review feedback and extracts recurring patterns.', method: 'POST', path: '/api/learning/conventions/extract',
    parameters: [
      { name: 'projectId', type: 'string', description: 'Project ID', required: true },
    ] },
] as const;

for (const tool of LEARNING_TOOLS) {
  registerToolDef(tool as any);
}

// ── Rank system ─────────────────────────────────────────────────────

interface Rank {
  name: string;
  title: string;
  minScore: number;
}

const RANKS: Rank[] = [
  { name: 'admiral', title: 'Admiral', minScore: 200 },
  { name: 'captain', title: 'Captain', minScore: 100 },
  { name: 'commander', title: 'Commander', minScore: 50 },
  { name: 'lieutenant', title: 'Lieutenant', minScore: 20 },
  { name: 'cadet', title: 'Cadet', minScore: 0 },
];

function getRank(totalScore: number): Rank {
  return RANKS.find(r => totalScore >= r.minScore) || RANKS[RANKS.length - 1];
}

// ── Routes ──────────────────────────────────────────────────────────

// POST /api/learning/reviews — submit a review
learningRouter.post('/reviews', requireScope('workflows:write'), (req, res) => {
  const { runId, stepId, score, result, feedback, issues, reviewer, executor, category } = req.body;

  if (!runId || !stepId || !score || !result) {
    return res.status(400).json({ error: 'runId, stepId, score, and result are required' });
  }
  if (score < 1 || score > 5) {
    return res.status(400).json({ error: 'score must be between 1 and 5' });
  }
  if (!['approved', 'rejected'].includes(result)) {
    return res.status(400).json({ error: 'result must be approved or rejected' });
  }

  const db = getDrizzle();
  const id = randomUUID();

  // Count existing reviews for this step (round number)
  const existing = db.select({ id: reviewRecords.id }).from(reviewRecords)
    .where(and(eq(reviewRecords.runId, runId), eq(reviewRecords.stepId, stepId))).all();
  const round = existing.length + 1;

  // Insert review record
  db.insert(reviewRecords).values({
    id,
    runId,
    stepId,
    reviewer: reviewer || (req as any).user?.name || 'unknown',
    executor: executor || null,
    score,
    result,
    feedback: feedback || '',
    issuesJson: typeof issues === 'string' ? issues : JSON.stringify(issues || []),
    round,
    category: category || null,
  }).run();

  // Update agent score
  if (executor) {
    const cat = category || 'overall';
    const existingScore = db.select().from(agentScores)
      .where(and(eq(agentScores.agentId, executor), eq(agentScores.category, cat))).get();

    if (existingScore) {
      const newCount = (existingScore.reviewCount || 0) + 1;
      const newTotal = (existingScore.totalScore || 0) + score;
      db.update(agentScores).set({
        totalScore: newTotal,
        reviewCount: newCount,
        avgScore: newTotal / newCount,
        lastUpdated: new Date().toISOString(),
      }).where(and(eq(agentScores.agentId, executor), eq(agentScores.category, cat))).run();
    } else {
      db.insert(agentScores).values({
        agentId: executor,
        category: cat,
        totalScore: score,
        reviewCount: 1,
        avgScore: score,
      }).run();
    }

    // Also update 'overall' scores if category is specific
    if (cat !== 'overall') {
      const overallScore = db.select().from(agentScores)
        .where(and(eq(agentScores.agentId, executor), eq(agentScores.category, 'overall'))).get();
      if (overallScore) {
        const newCount = (overallScore.reviewCount || 0) + 1;
        const newTotal = (overallScore.totalScore || 0) + score;
        db.update(agentScores).set({
          totalScore: newTotal, reviewCount: newCount, avgScore: newTotal / newCount,
          lastUpdated: new Date().toISOString(),
        }).where(and(eq(agentScores.agentId, executor), eq(agentScores.category, 'overall'))).run();
      } else {
        db.insert(agentScores).values({
          agentId: executor, category: 'overall', totalScore: score, reviewCount: 1, avgScore: score,
        }).run();
      }
    }
  }

  // If rejected, extract lesson from feedback
  if (result === 'rejected' && feedback && executor) {
    const lessonId = randomUUID();
    db.insert(agentLessons).values({
      id: lessonId,
      agentId: executor,
      projectId: null, // Could be resolved from run
      lesson: feedback,
      source: 'review',
      severity: score <= 2 ? 'high' : 'medium',
      reviewId: id,
    }).run();
  }

  const agentScore = executor
    ? db.select().from(agentScores).where(and(eq(agentScores.agentId, executor), eq(agentScores.category, category || 'overall'))).get()
    : null;

  res.status(201).json({
    id,
    round,
    ...(agentScore && {
      agentScore: {
        total: agentScore.totalScore,
        average: agentScore.avgScore,
        reviews: agentScore.reviewCount,
        rank: getRank(agentScore.totalScore || 0),
      },
    }),
  });
});

// GET /api/learning/reviews — list reviews for a run
learningRouter.get('/reviews', requireScope('workflows:read'), (req, res) => {
  const { runId, executor } = req.query;
  const db = getDrizzle();

  let query = db.select().from(reviewRecords);
  if (runId) query = query.where(eq(reviewRecords.runId, runId as string)) as any;
  if (executor) query = query.where(eq(reviewRecords.executor, executor as string)) as any;

  const results = (query as any).orderBy(desc(reviewRecords.createdAt)).limit(50).all();
  res.json(results);
});

// POST /api/learning/agent-score — get agent score + rank
learningRouter.post('/agent-score', requireScope('workflows:read'), (req, res) => {
  const { agent } = req.body;
  if (!agent) return res.status(400).json({ error: 'agent is required' });

  const db = getDrizzle();
  const scores = db.select().from(agentScores).where(eq(agentScores.agentId, agent)).all();

  const overall = scores.find(s => s.category === 'overall') || { totalScore: 0, reviewCount: 0, avgScore: 0 };
  const categories = scores.filter(s => s.category !== 'overall');

  res.json({
    agent,
    rank: getRank(overall.totalScore || 0),
    overall: {
      totalScore: overall.totalScore,
      reviewCount: overall.reviewCount,
      avgScore: overall.avgScore,
    },
    categories: categories.map(c => ({
      category: c.category,
      totalScore: c.totalScore,
      reviewCount: c.reviewCount,
      avgScore: c.avgScore,
    })),
  });
});

// POST /api/learning/agent-lessons — get active lessons for injection
learningRouter.post('/agent-lessons', requireScope('workflows:read'), (req, res) => {
  const { agent, projectId } = req.body;
  if (!agent) return res.status(400).json({ error: 'agent is required' });

  const db = getDrizzle();
  let conditions = [eq(agentLessons.agentId, agent), eq(agentLessons.active, 1)];
  if (projectId) conditions.push(eq(agentLessons.projectId, projectId));

  const lessons = db.select().from(agentLessons)
    .where(and(...conditions))
    .orderBy(desc(agentLessons.createdAt))
    .limit(10)
    .all();

  res.json(lessons);
});

// POST /api/learning/conventions — get project conventions
learningRouter.post('/conventions', requireScope('projects:read'), (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });

  const db = getDrizzle();
  const conventions = db.select().from(projectConventions)
    .where(and(eq(projectConventions.projectId, projectId), eq(projectConventions.active, 1)))
    .orderBy(desc(projectConventions.evidenceCount))
    .all();

  res.json(conventions);
});

// POST /api/learning/conventions/add — add a convention manually
learningRouter.post('/conventions/add', requireScope('projects:write'), (req, res) => {
  const { projectId, convention } = req.body;
  if (!projectId || !convention) return res.status(400).json({ error: 'projectId and convention required' });

  const db = getDrizzle();
  const id = randomUUID();
  db.insert(projectConventions).values({
    id,
    projectId,
    convention,
    source: 'manual',
  }).run();

  res.status(201).json({ id, convention });
});

// POST /api/learning/conventions/extract — manually trigger convention extraction
learningRouter.post('/conventions/extract', requireScope('projects:write'), async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });

  try {
    const { extractConventions } = await import('../services/convention-extractor.js');
    const result = await extractConventions(projectId);
    res.json(result);
  } catch (err) {
    console.error('[learning] Convention extraction failed:', err);
    res.status(500).json({ error: 'Extraction failed', message: (err as Error).message });
  }
});

// GET /api/learning/leaderboard — agent score leaderboard
learningRouter.get('/leaderboard', requireScope('workflows:read'), (_req, res) => {
  const db = getDrizzle();
  const scores = db.select().from(agentScores)
    .where(eq(agentScores.category, 'overall'))
    .orderBy(desc(agentScores.totalScore))
    .all();

  res.json(scores.map(s => ({
    agent: s.agentId,
    totalScore: s.totalScore,
    reviewCount: s.reviewCount,
    avgScore: s.avgScore,
    rank: getRank(s.totalScore || 0),
  })));
});

// GET /api/learning/lessons/:agentId/context — formatted lesson context for prompt injection
learningRouter.get('/lessons/:agentId/context', requireScope('workflows:read'), (req, res) => {
  const agentId = req.params.agentId;
  const projectId = req.query.projectId as string | undefined;
  const db = getDrizzle();

  // Get agent lessons
  let conditions = [eq(agentLessons.agentId, agentId), eq(agentLessons.active, 1)];
  if (projectId) conditions.push(eq(agentLessons.projectId, projectId));

  const lessons = db.select().from(agentLessons)
    .where(and(...conditions))
    .orderBy(desc(agentLessons.createdAt))
    .limit(5)
    .all();

  // Get agent score + rank
  const score = db.select().from(agentScores)
    .where(and(eq(agentScores.agentId, agentId), eq(agentScores.category, 'overall'))).get();

  // Get project conventions
  const conventions = projectId
    ? db.select().from(projectConventions)
        .where(and(eq(projectConventions.projectId, projectId), eq(projectConventions.active, 1)))
        .orderBy(desc(projectConventions.evidenceCount))
        .limit(10)
        .all()
    : [];

  // Increment injection counter
  for (const l of lessons) {
    db.update(agentLessons).set({ timesInjected: (l.timesInjected || 0) + 1 }).where(eq(agentLessons.id, l.id)).run();
  }

  // Format for prompt injection
  const rank = getRank(score?.totalScore || 0);
  let context = `[AGENT CONTEXT]\nRank: ${rank.title} (score: ${score?.totalScore || 0}, avg: ${(score?.avgScore || 0).toFixed(1)}/5)\n`;

  if (lessons.length > 0) {
    context += `\nYour recent lessons (learn from past reviews):\n`;
    for (const l of lessons) {
      const icon = l.severity === 'high' ? '🔴' : '⚠️';
      context += `- ${icon} ${l.lesson}\n`;
    }
  }

  if (conventions.length > 0) {
    context += `\n[PROJECT CONVENTIONS]\n`;
    for (const c of conventions) {
      context += `- ${c.convention}\n`;
    }
  }

  res.json({ context, lessonsCount: lessons.length, conventionsCount: conventions.length, rank });
});
