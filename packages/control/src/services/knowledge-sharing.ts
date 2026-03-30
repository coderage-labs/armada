/**
 * Knowledge sharing service — promotes lessons to conventions.
 * When multiple agents receive similar lessons for the same project,
 * auto-promote the lesson to a shared project convention.
 * Part of Learning System Phase 1 (#224).
 */

import { getDrizzle } from '../db/drizzle.js';
import { agentLessons, projectConventions, agentScores } from '../db/drizzle-schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

interface PromotionResult {
  promoted: number;
  skipped: number;
}

// ── Text similarity ──────────────────────────────────────────────────

/**
 * Normalize text for comparison — lowercase, strip punctuation, trim whitespace.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate Jaccard similarity between two sets of words.
 * Returns value between 0 (no overlap) and 1 (identical).
 */
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  
  return intersection.size / union.size;
}

// ── Lesson grouping ──────────────────────────────────────────────────

interface LessonGroup {
  text: string;
  normalized: string;
  agentIds: Set<string>;
  lessonIds: string[];
}

/**
 * Group similar lessons together using Jaccard similarity.
 * Only groups lessons from different agents (same agent's lessons don't count as shared).
 */
function groupSimilarLessons(lessons: Array<{ id: string; agentId: string; lesson: string }>): LessonGroup[] {
  const groups: LessonGroup[] = [];
  
  for (const lesson of lessons) {
    const normalized = normalizeText(lesson.lesson);
    
    // Try to find matching group
    let matched = false;
    for (const group of groups) {
      if (jaccardSimilarity(normalized, group.normalized) > 0.5) {
        // Only add if this agent isn't already in the group
        if (!group.agentIds.has(lesson.agentId)) {
          group.agentIds.add(lesson.agentId);
          group.lessonIds.push(lesson.id);
          matched = true;
          break;
        }
      }
    }
    
    // Create new group if no match found
    if (!matched) {
      groups.push({
        text: lesson.lesson,
        normalized,
        agentIds: new Set([lesson.agentId]),
        lessonIds: [lesson.id],
      });
    }
  }
  
  return groups;
}

// ── Convention matching ──────────────────────────────────────────────

/**
 * Check if a convention already exists (fuzzy match).
 * Returns the existing convention ID if found, null otherwise.
 */
function findExistingConvention(projectId: string, conventionText: string): string | null {
  const db = getDrizzle();
  const existing = db.select()
    .from(projectConventions)
    .where(and(
      eq(projectConventions.projectId, projectId),
      eq(projectConventions.active, 1)
    ))
    .all();
  
  const normalized = normalizeText(conventionText);
  
  for (const conv of existing) {
    if (jaccardSimilarity(normalized, normalizeText(conv.convention)) > 0.7) {
      return conv.id;
    }
  }
  
  return null;
}

// ── Mentor filter ────────────────────────────────────────────────────

/**
 * Get average score for an agent (Commander+ rank = 3.0+ avg score).
 * Returns null if agent has no scores.
 */
function getAgentAvgScore(agentId: string): number | null {
  const db = getDrizzle();
  const score = db.select()
    .from(agentScores)
    .where(and(
      eq(agentScores.agentId, agentId),
      eq(agentScores.category, 'overall')
    ))
    .get();
  
  return score ? score.avgScore : null;
}

/**
 * Filter lessons to only include those from agents with avg score >= 3.0.
 * Lessons from poorly-performing agents shouldn't propagate.
 */
function filterMentorLessons(lessons: Array<{ id: string; agentId: string; lesson: string }>): Array<{ id: string; agentId: string; lesson: string }> {
  return lessons.filter(lesson => {
    const avgScore = getAgentAvgScore(lesson.agentId);
    // If no score yet (new agent), allow; otherwise require >= 3.0
    return avgScore === null || avgScore >= 3.0;
  });
}

// ── Main promotion function ──────────────────────────────────────────

/**
 * Scan agent lessons for patterns that should be shared as conventions.
 * When N different agents have similar lessons for the same project,
 * promote the lesson to a project convention.
 */
export async function promoteLessonsToConventions(projectId: string): Promise<PromotionResult> {
  console.log(`[knowledge-sharing] Checking lessons for project ${projectId}`);
  
  const db = getDrizzle();
  
  // 1. Query active lessons for this project from last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rawLessons = db.select({
    id: agentLessons.id,
    agentId: agentLessons.agentId,
    lesson: agentLessons.lesson,
    createdAt: agentLessons.createdAt,
  })
    .from(agentLessons)
    .where(and(
      eq(agentLessons.projectId, projectId),
      eq(agentLessons.active, 1),
      sql`${agentLessons.createdAt} >= ${thirtyDaysAgo}`
    ))
    .all();
  
  console.log(`[knowledge-sharing] Found ${rawLessons.length} active lessons in last 30 days`);
  
  if (rawLessons.length < 2) {
    console.log(`[knowledge-sharing] Not enough lessons to check for shared patterns`);
    return { promoted: 0, skipped: 0 };
  }
  
  // 2. Filter to only include lessons from mentors (avg score >= 3.0)
  const lessons = filterMentorLessons(rawLessons as any);
  console.log(`[knowledge-sharing] ${lessons.length} lessons from mentor-level agents (avg >= 3.0)`);
  
  if (lessons.length < 2) {
    console.log(`[knowledge-sharing] Not enough mentor lessons to promote`);
    return { promoted: 0, skipped: 0 };
  }
  
  // 3. Group by similarity
  const groups = groupSimilarLessons(lessons);
  console.log(`[knowledge-sharing] Grouped into ${groups.length} clusters`);
  
  let promoted = 0;
  let skipped = 0;
  
  // 4. For each group with 2+ agents, promote to convention
  for (const group of groups) {
    if (group.agentIds.size < 2) {
      skipped++;
      continue;
    }
    
    console.log(`[knowledge-sharing] Found shared pattern across ${group.agentIds.size} agents: "${group.text.slice(0, 60)}..."`);
    
    // 5. Check if convention already exists
    const existingId = findExistingConvention(projectId, group.text);
    
    if (existingId) {
      console.log(`[knowledge-sharing] Convention already exists (${existingId}), skipping`);
      skipped++;
      continue;
    }
    
    // 6. Create new convention with source 'shared-lesson'
    const id = randomUUID();
    db.insert(projectConventions).values({
      id,
      projectId,
      convention: group.text,
      source: 'shared-lesson',
      evidenceCount: group.agentIds.size,
    }).run();
    
    console.log(`[knowledge-sharing] Created convention ${id} from ${group.agentIds.size} agents`);
    promoted++;
    
    // Optional: Mark lessons as promoted (future enhancement)
    // For now, lessons remain active so agents continue to see them
  }
  
  console.log(`[knowledge-sharing] Complete: ${promoted} promoted, ${skipped} skipped`);
  
  return { promoted, skipped };
}
