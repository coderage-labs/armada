/**
 * Embedding service for semantic search.
 * Uses OpenRouter API for generating embeddings.
 */

import { getDb } from '../db/index.js';

const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/embeddings';

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * Embed a single text using OpenRouter.
 */
export async function embedText(text: string): Promise<number[]> {
  const result = await embedTexts([text]);
  return result[0];
}

/**
 * Embed multiple texts in one API call (batch).
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn('[embedding] OPENROUTER_API_KEY not set — semantic search disabled');
    return texts.map(() => []);
  }

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
    }

    const data: EmbeddingResponse = await response.json();
    return data.data.map(item => item.embedding);
  } catch (err: any) {
    console.error('[embedding] Failed to generate embeddings:', err.message);
    return texts.map(() => []);
  }
}

/**
 * Store an embedding in the database.
 */
export async function storeEmbedding(
  entityType: string,
  entityId: string,
  text: string,
): Promise<void> {
  const vector = await embedText(text);
  if (vector.length === 0) return; // Skip if embedding failed

  const db = getDb();
  const id = `${entityType}:${entityId}`;

  db.prepare(`
    INSERT OR REPLACE INTO embeddings (id, entity_type, entity_id, text, vector_json, model)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, entityType, entityId, text, JSON.stringify(vector), EMBEDDING_MODEL);
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Semantic search — find entities by embedding similarity.
 */
export async function semanticSearch(
  query: string,
  entityType: string,
  limit = 10,
): Promise<Array<{ entityId: string; text: string; score: number }>> {
  const queryVector = await embedText(query);
  if (queryVector.length === 0) {
    console.warn('[embedding] Semantic search disabled — no API key');
    return [];
  }

  const db = getDb();
  const rows = db.prepare(`
    SELECT entity_id, text, vector_json
    FROM embeddings
    WHERE entity_type = ?
  `).all(entityType) as Array<{ entity_id: string; text: string; vector_json: string }>;

  const results = rows.map(row => {
    const vector = JSON.parse(row.vector_json) as number[];
    const score = cosineSimilarity(queryVector, vector);
    return { entityId: row.entity_id, text: row.text, score };
  });

  // Sort by score descending, return top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
