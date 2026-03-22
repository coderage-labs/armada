/**
 * Convention extraction service — analyzes review feedback and extracts
 * recurring patterns as project conventions.
 * Part of Learning System Phase 3 (#185).
 */

import { getDrizzle } from '../db/drizzle.js';
import { reviewRecords, workflowRuns, projectConventions } from '../db/drizzle-schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

interface ExtractionResult {
  newConventions: number;
  updatedConventions: number;
  totalReviewsAnalysed: number;
}

// ── Extraction tracker ─────────────────────────────────────────────
// In-memory tracker for when to run extraction per project
const projectExtractionTrackers = new Map<string, { completedRuns: number; lastExtractionAt: string }>();

/**
 * Check if convention extraction should run for this project.
 * Runs every 5 completed workflow runs.
 */
export function shouldExtractConventions(projectId: string): boolean {
  const tracker = projectExtractionTrackers.get(projectId) || { completedRuns: 0, lastExtractionAt: '' };
  tracker.completedRuns++;
  projectExtractionTrackers.set(projectId, tracker);

  if (tracker.completedRuns >= 5) {
    // Reset counter
    tracker.completedRuns = 0;
    tracker.lastExtractionAt = new Date().toISOString();
    return true;
  }
  return false;
}

// ── Text normalization ──────────────────────────────────────────────

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
 * Split text into sentences (simple approach — split on . ! ? followed by space).
 */
function splitIntoSentences(text: string): string[] {
  return text
    .split(/[.!?]+\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 10); // Skip very short fragments
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

/**
 * Find recurring patterns in feedback sentences.
 * Returns sentences that appear (or are very similar) across 3+ reviews.
 */
function findRecurringPatterns(feedbackTexts: string[]): Map<string, number> {
  // Extract all sentences from all feedback
  const allSentences = feedbackTexts.flatMap(text => splitIntoSentences(text));
  const normalizedSentences = allSentences.map(normalizeText);
  
  // Group similar sentences
  const clusters = new Map<string, { original: string; count: number; normalized: string }>();
  
  for (let i = 0; i < normalizedSentences.length; i++) {
    const normalized = normalizedSentences[i];
    const original = allSentences[i];
    
    // Check if this sentence matches any existing cluster
    let matched = false;
    for (const [key, cluster] of clusters.entries()) {
      if (jaccardSimilarity(normalized, cluster.normalized) > 0.5) {
        cluster.count++;
        matched = true;
        break;
      }
    }
    
    if (!matched) {
      clusters.set(original, { original, count: 1, normalized });
    }
  }
  
  // Return only patterns that appear 3+ times
  const recurring = new Map<string, number>();
  for (const [_key, cluster] of clusters.entries()) {
    if (cluster.count >= 3) {
      recurring.set(cluster.original, cluster.count);
    }
  }
  
  return recurring;
}

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

// ── Main extraction function ────────────────────────────────────────

/**
 * Extract conventions from review feedback for a project.
 * Analyzes rejected reviews, finds recurring patterns, and creates/updates conventions.
 */
export async function extractConventions(projectId: string): Promise<ExtractionResult> {
  console.log(`[convention-extractor] Running extraction for project ${projectId}`);
  
  const db = getDrizzle();
  
  // 1. Query all review records for this project (join through workflow_runs)
  const reviews = db.select({
    reviewId: reviewRecords.id,
    result: reviewRecords.result,
    feedback: reviewRecords.feedback,
    runId: reviewRecords.runId,
  })
    .from(reviewRecords)
    .innerJoin(workflowRuns, eq(reviewRecords.runId, workflowRuns.id))
    .where(eq(workflowRuns.projectId, projectId))
    .all();
  
  console.log(`[convention-extractor] Found ${reviews.length} total reviews`);
  
  // 2. Filter for rejected reviews with feedback
  const rejectedReviews = reviews.filter(r => 
    r.result === 'rejected' && 
    r.feedback && 
    r.feedback.length > 10
  );
  
  console.log(`[convention-extractor] ${rejectedReviews.length} rejected reviews with feedback`);
  
  if (rejectedReviews.length < 3) {
    console.log(`[convention-extractor] Not enough rejected reviews to extract patterns`);
    return {
      newConventions: 0,
      updatedConventions: 0,
      totalReviewsAnalysed: reviews.length,
    };
  }
  
  // 3. Extract recurring patterns
  const feedbackTexts = rejectedReviews.map(r => r.feedback!);
  const patterns = findRecurringPatterns(feedbackTexts);
  
  console.log(`[convention-extractor] Found ${patterns.size} recurring patterns`);
  
  let newConventions = 0;
  let updatedConventions = 0;
  
  // 4. For each pattern, check if convention exists or create new one
  for (const [pattern, evidenceCount] of patterns.entries()) {
    const existingId = findExistingConvention(projectId, pattern);
    
    if (existingId) {
      // Update evidence count
      const existing = db.select()
        .from(projectConventions)
        .where(eq(projectConventions.id, existingId))
        .get();
      
      if (existing) {
        db.update(projectConventions)
          .set({ evidenceCount: (existing.evidenceCount || 0) + evidenceCount })
          .where(eq(projectConventions.id, existingId))
          .run();
        updatedConventions++;
        console.log(`[convention-extractor] Updated convention ${existingId}: "${pattern.slice(0, 60)}..."`);
      }
    } else {
      // Create new convention
      const id = randomUUID();
      db.insert(projectConventions).values({
        id,
        projectId,
        convention: pattern,
        source: 'extracted',
        evidenceCount,
      }).run();
      newConventions++;
      console.log(`[convention-extractor] Created convention ${id}: "${pattern.slice(0, 60)}..."`);
    }
  }
  
  console.log(`[convention-extractor] Complete: ${newConventions} new, ${updatedConventions} updated`);
  
  return {
    newConventions,
    updatedConventions,
    totalReviewsAnalysed: reviews.length,
  };
}
