/**
 * Workflow Artifacts — file storage and retrieval between workflow steps (#113).
 *
 * Agents upload files as base64-encoded content. Files are stored on disk at
 * /data/artifacts/<runId>/<stepId>/<filename> and metadata in SQLite.
 * Subsequent steps can list and download artifacts from previous steps.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync, createReadStream, readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { getDrizzle } from '../db/drizzle.js';
import { workflowArtifacts } from '../db/drizzle-schema.js';
import { eq, and, sum } from 'drizzle-orm';
import { requireScope } from '../middleware/scopes.js';
import { registerToolDef } from '../utils/tool-registry.js';

// ── Tool definitions ────────────────────────────────────────────────

registerToolDef({
  name: 'armada_artifact_upload',
  description: 'Upload a file as a workflow artifact. Other steps can download it later. Use this to share code files, configs, reports between workflow steps. Content must be base64-encoded.',
  method: 'POST',
  path: '/api/workflows/runs/:runId/artifacts',
  parameters: [
    { name: 'runId', type: 'string', description: 'Workflow run ID (available in your workflow context)', required: true },
    { name: 'stepId', type: 'string', description: 'Your step ID (available in your workflow context)', required: true },
    { name: 'filename', type: 'string', description: 'Filename (e.g. src/fix.ts)', required: true },
    { name: 'content', type: 'string', description: 'File content, base64-encoded', required: true },
    { name: 'mimeType', type: 'string', description: 'MIME type (default: application/octet-stream)' },
  ],
  scope: 'workflows:write',
});

registerToolDef({
  name: 'armada_artifact_list',
  description: 'List all artifacts for a workflow run. Shows files uploaded by all completed steps.',
  method: 'GET',
  path: '/api/workflows/runs/:runId/artifacts',
  parameters: [
    { name: 'runId', type: 'string', description: 'Workflow run ID', required: true },
    { name: 'stepId', type: 'string', description: 'Filter by step ID (optional)' },
  ],
  scope: 'workflows:read',
});

registerToolDef({
  name: 'armada_artifact_download',
  description: 'Download a workflow artifact by ID. Returns the file content.',
  method: 'GET',
  path: '/api/workflows/runs/:runId/artifacts/:artifactId',
  parameters: [
    { name: 'runId', type: 'string', description: 'Workflow run ID', required: true },
    { name: 'artifactId', type: 'string', description: 'Artifact ID', required: true },
  ],
  scope: 'workflows:read',
});

// ── Constants ───────────────────────────────────────────────────────

const ARTIFACT_BASE_DIR = '/data/artifacts';
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;   // 10 MB per file
const MAX_RUN_SIZE_BYTES  = 100 * 1024 * 1024;  // 100 MB per run

// ── Helper: safe storage path ────────────────────────────────────────

function artifactStoragePath(runId: string, stepId: string, filename: string): string {
  // Sanitise to prevent path traversal
  const safeFilename = basename(filename).replace(/\.\./g, '_');
  const safeStepId  = stepId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeRunId   = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(ARTIFACT_BASE_DIR, safeRunId, safeStepId, safeFilename);
}

// ── Helper: format bytes ─────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Router ──────────────────────────────────────────────────────────

const router = Router();

// POST /api/workflows/runs/:runId/artifacts
router.post('/:runId/artifacts', requireScope('workflows:write'), async (req, res) => {
  try {
    const { runId } = req.params;
    const { stepId, filename, content, mimeType } = req.body as {
      stepId?: string;
      filename?: string;
      content?: string;
      mimeType?: string;
    };

    if (!stepId || typeof stepId !== 'string') {
      res.status(400).json({ error: 'stepId is required' });
      return;
    }
    if (!filename || typeof filename !== 'string') {
      res.status(400).json({ error: 'filename is required' });
      return;
    }
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content (base64) is required' });
      return;
    }

    // Decode content
    const buffer = Buffer.from(content, 'base64');
    const size = buffer.byteLength;

    // Per-file size limit
    if (size > MAX_FILE_SIZE_BYTES) {
      res.status(413).json({ error: `File too large: ${formatBytes(size)} exceeds the 10 MB limit` });
      return;
    }

    // Per-run total size limit
    const db = getDrizzle();
    const totalResult = await db
      .select({ total: sum(workflowArtifacts.size) })
      .from(workflowArtifacts)
      .where(eq(workflowArtifacts.runId, runId));
    const currentTotal = Number(totalResult[0]?.total ?? 0);

    if (currentTotal + size > MAX_RUN_SIZE_BYTES) {
      res.status(413).json({
        error: `Run artifact storage limit exceeded: ${formatBytes(currentTotal + size)} would exceed the 100 MB limit`,
      });
      return;
    }

    // Write file to disk
    const storagePath = artifactStoragePath(runId, stepId, filename);
    mkdirSync(dirname(storagePath), { recursive: true });
    writeFileSync(storagePath, buffer);

    // Store metadata in DB
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const resolvedMimeType = mimeType || 'application/octet-stream';

    await db.insert(workflowArtifacts).values({
      id,
      runId,
      stepId,
      filename: basename(filename),
      mimeType: resolvedMimeType,
      size,
      storagePath,
      createdAt,
    });

    res.status(201).json({ id, filename: basename(filename), stepId, mimeType: resolvedMimeType, size });
  } catch (err) {
    console.error('[workflow-artifacts] POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/workflows/runs/:runId/artifacts
router.get('/:runId/artifacts', requireScope('workflows:read'), async (req, res) => {
  try {
    const { runId } = req.params;
    const { stepId } = req.query as { stepId?: string };

    const db = getDrizzle();
    const conditions = [eq(workflowArtifacts.runId, runId)];
    if (stepId) {
      conditions.push(eq(workflowArtifacts.stepId, stepId));
    }

    const rows = await db
      .select({
        id: workflowArtifacts.id,
        stepId: workflowArtifacts.stepId,
        filename: workflowArtifacts.filename,
        mimeType: workflowArtifacts.mimeType,
        size: workflowArtifacts.size,
        createdAt: workflowArtifacts.createdAt,
      })
      .from(workflowArtifacts)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions));

    res.json(rows);
  } catch (err) {
    console.error('[workflow-artifacts] GET list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/workflows/runs/:runId/artifacts/:artifactId
router.get('/:runId/artifacts/:artifactId', requireScope('workflows:read'), async (req, res) => {
  try {
    const { runId, artifactId } = req.params;
    const { download } = req.query as { download?: string };

    const db = getDrizzle();
    const rows = await db
      .select()
      .from(workflowArtifacts)
      .where(and(
        eq(workflowArtifacts.id, artifactId),
        eq(workflowArtifacts.runId, runId),
      ));

    const artifact = rows[0];
    if (!artifact) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }

    if (!existsSync(artifact.storagePath)) {
      res.status(404).json({ error: 'Artifact file not found on disk' });
      return;
    }

    // If requested as raw download (browser/curl), stream the file
    if (download === 'true') {
      res.setHeader('Content-Type', artifact.mimeType);
      res.setHeader('Content-Length', artifact.size);
      res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
      const stream = createReadStream(artifact.storagePath);
      stream.pipe(res);
      return;
    }

    // For tool/API access: return content as JSON so agents can read it inline
    const isText = artifact.mimeType.startsWith('text/') ||
      artifact.mimeType === 'application/json' ||
      artifact.mimeType === 'application/javascript' ||
      artifact.mimeType === 'application/xml' ||
      artifact.mimeType === 'application/yaml' ||
      artifact.filename.endsWith('.md') ||
      artifact.filename.endsWith('.txt') ||
      artifact.filename.endsWith('.json') ||
      artifact.filename.endsWith('.yml') ||
      artifact.filename.endsWith('.yaml') ||
      artifact.filename.endsWith('.ts') ||
      artifact.filename.endsWith('.js') ||
      artifact.filename.endsWith('.py') ||
      artifact.filename.endsWith('.sh');

    if (isText && artifact.size < 1_000_000) {
      // Return text content inline as JSON — agents can read it directly
      const content = readFileSync(artifact.storagePath, 'utf-8');
      res.json({
        id: artifact.id,
        filename: artifact.filename,
        stepId: artifact.stepId,
        mimeType: artifact.mimeType,
        size: artifact.size,
        content,
      });
    } else {
      // Binary or large files: return base64-encoded
      const buffer = readFileSync(artifact.storagePath);
      res.json({
        id: artifact.id,
        filename: artifact.filename,
        stepId: artifact.stepId,
        mimeType: artifact.mimeType,
        size: artifact.size,
        encoding: 'base64',
        content: buffer.toString('base64'),
      });
    }
  } catch (err) {
    console.error('[workflow-artifacts] GET download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/workflows/runs/:runId/artifacts/:artifactId
router.delete('/:runId/artifacts/:artifactId', requireScope('workflows:write'), async (req, res) => {
  try {
    const { runId, artifactId } = req.params;

    const db = getDrizzle();
    const rows = await db
      .select()
      .from(workflowArtifacts)
      .where(and(
        eq(workflowArtifacts.id, artifactId),
        eq(workflowArtifacts.runId, runId),
      ));

    const artifact = rows[0];
    if (!artifact) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }

    // Delete file from disk (best effort)
    try {
      if (existsSync(artifact.storagePath)) {
        unlinkSync(artifact.storagePath);
      }
    } catch (fsErr) {
      console.warn('[workflow-artifacts] Failed to delete file:', fsErr);
    }

    // Remove DB record
    await db.delete(workflowArtifacts).where(eq(workflowArtifacts.id, artifactId));

    res.status(204).send();
  } catch (err) {
    console.error('[workflow-artifacts] DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

// ── Exported helper for workflow-engine context injection ────────────

/**
 * Build an artifact listing for a workflow run (excluding the current step).
 * Returns null when no artifacts exist.
 */
export async function getArtifactContextBlock(
  runId: string,
  currentStepId: string,
): Promise<string | null> {
  try {
    const db = getDrizzle();
    const rows = await db
      .select({
        stepId: workflowArtifacts.stepId,
        filename: workflowArtifacts.filename,
        mimeType: workflowArtifacts.mimeType,
        size: workflowArtifacts.size,
      })
      .from(workflowArtifacts)
      .where(eq(workflowArtifacts.runId, runId));

    // Exclude artifacts from the current step (show only "previous" steps)
    const others = rows.filter(r => r.stepId !== currentStepId);

    const lines = [
      '## File Artifacts',
      'If your work produces files that subsequent steps need to review or build upon, upload them using armada_artifact_upload. Only upload files that are relevant to the workflow — not every file you touch.',
    ];

    if (others.length > 0) {
      lines.push('', 'Available artifacts from completed steps:');
      for (const a of others) {
        lines.push(`- ${a.stepId}/${a.filename} (${formatBytes(a.size)}, ${a.mimeType})`);
      }
      lines.push('Use armada_artifact_download to retrieve any artifact you need.');
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}
