import { resolve, extname, basename } from 'path';
import { readFile, writeFile, readdir, stat, unlink, mkdir, copyFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import type { CommandMessage, ResponseMessage } from '@coderage-labs/armada-shared';
import { WsErrorCode } from '@coderage-labs/armada-shared';

/** Staging area for shared files between agents */
const SHARED_FILES_DIR = process.env.ARMADA_SHARED_FILES_DIR || '/data/armada/shared-files';

/** Base directory where per-instance data volumes live */
const ARMADA_INSTANCES_DIR = process.env.ARMADA_INSTANCES_DIR || '/data/armada/instances';

const DATA_DIR = process.env.DATA_DIR || '/data';

function validatePath(requestedPath: string): string {
  const resolved = resolve(DATA_DIR, requestedPath.startsWith('/') ? requestedPath.slice(1) : requestedPath);
  // Ensure resolved path stays within DATA_DIR
  const normalizedDataDir = resolve(DATA_DIR);
  if (!resolved.startsWith(normalizedDataDir + '/') && resolved !== normalizedDataDir) {
    throw Object.assign(new Error('Path outside data directory'), { code: WsErrorCode.PERMISSION_DENIED });
  }
  return resolved;
}

function errorResponse(msg: CommandMessage, err: unknown): ResponseMessage {
  const e = err as Error & { code?: string };
  const isPermission = e.code === WsErrorCode.PERMISSION_DENIED;
  const isNotFound = (e as NodeJS.ErrnoException).code === 'ENOENT';
  return {
    type: 'response',
    id: msg.id,
    status: 'error',
    error: e.message,
    code: isPermission
      ? WsErrorCode.PERMISSION_DENIED
      : isNotFound
        ? WsErrorCode.FILE_NOT_FOUND
        : WsErrorCode.UNKNOWN,
  };
}

async function handleFileRead(msg: CommandMessage): Promise<ResponseMessage> {
  const { path } = msg.params as { path: string };
  if (!path) {
    return { type: 'response', id: msg.id, status: 'error', error: 'path is required', code: WsErrorCode.UNKNOWN };
  }
  const resolved = validatePath(path);
  const buf = await readFile(resolved);
  // Use base64 for large files (>1MB) or non-text content
  if (buf.length > 1_048_576) {
    return { type: 'response', id: msg.id, status: 'ok', data: { content: buf.toString('base64'), encoding: 'base64', size: buf.length } };
  }
  return { type: 'response', id: msg.id, status: 'ok', data: { content: buf.toString('utf8'), encoding: 'utf8', size: buf.length } };
}

async function handleFileWrite(msg: CommandMessage): Promise<ResponseMessage> {
  const { instance, path, content, encoding = 'utf8' } = msg.params as { 
    instance?: string; 
    path: string; 
    content: string; 
    encoding?: 'utf8' | 'base64' 
  };
  if (!path || content === undefined) {
    return { type: 'response', id: msg.id, status: 'error', error: 'path and content are required', code: WsErrorCode.UNKNOWN };
  }
  
  let resolved: string;
  if (instance) {
    // Writing to an instance data volume
    // Path should be absolute within the container (e.g., /home/node/.openclaw/workspace/SOUL.md)
    // We need to map it to the host-side volume path
    const instanceDataDir = `${ARMADA_INSTANCES_DIR}/${instance}`;
    
    // Strip /home/node/.openclaw prefix if present, since that's the container mount point
    const containerPrefix = '/home/node/.openclaw';
    const relativePath = path.startsWith(containerPrefix) 
      ? path.slice(containerPrefix.length)
      : path;
    
    // Ensure path doesn't start with / after prefix removal
    const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    resolved = resolve(instanceDataDir, cleanPath);
  } else {
    // Writing to DATA_DIR (legacy behavior)
    resolved = validatePath(path);
  }
  
  // Create parent directories if needed
  const dir = resolved.substring(0, resolved.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  const data = encoding === 'base64' ? Buffer.from(content, 'base64') : content;
  await writeFile(resolved, data);
  const info = await stat(resolved);
  return { type: 'response', id: msg.id, status: 'ok', data: { path: resolved, size: info.size } };
}

async function handleFileList(msg: CommandMessage): Promise<ResponseMessage> {
  const { path } = msg.params as { path: string };
  if (!path) {
    return { type: 'response', id: msg.id, status: 'error', error: 'path is required', code: WsErrorCode.UNKNOWN };
  }
  const resolved = validatePath(path);
  const entries = await readdir(resolved, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      let size = 0;
      try {
        const s = await stat(resolve(resolved, entry.name));
        size = s.size;
      } catch (err: any) { console.warn('[files] stat failed:', err.message); }
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size,
      };
    })
  );
  return { type: 'response', id: msg.id, status: 'ok', data: { entries: items } };
}

const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const MAX_DOWNLOAD_SIZE = 10 * 1024 * 1024; // 10MB

async function handleFileDownload(msg: CommandMessage): Promise<ResponseMessage> {
  const { path } = msg.params as { path: string };
  if (!path) {
    return { type: 'response', id: msg.id, status: 'error', error: 'path is required', code: WsErrorCode.UNKNOWN };
  }
  const resolved = validatePath(path);
  const info = await stat(resolved);
  if (info.size > MAX_DOWNLOAD_SIZE) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: `File too large for download over WS: ${info.size} bytes (max ${MAX_DOWNLOAD_SIZE})`,
      code: WsErrorCode.UNKNOWN,
    };
  }
  const buf = await readFile(resolved);
  const ext = extname(resolved).toLowerCase();
  const mimeType = MIME_MAP[ext] || 'application/octet-stream';
  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: {
      data: buf.toString('base64'),
      size: buf.length,
      mimeType,
    },
  };
}

async function handleFileDelete(msg: CommandMessage): Promise<ResponseMessage> {
  const { path } = msg.params as { path: string };
  if (!path) {
    return { type: 'response', id: msg.id, status: 'error', error: 'path is required', code: WsErrorCode.UNKNOWN };
  }
  const resolved = validatePath(path);
  await unlink(resolved);
  return { type: 'response', id: msg.id, status: 'ok', data: { deleted: resolved } };
}

// ── file.share / file.deliver ─────────────────────────────────────────────────

/**
 * Resolve the host-side data directory for an agent/instance by name.
 * Agents are placed inside instances; the instance data volume is at
 * ARMADA_INSTANCES_DIR/{name}. As a fallback we also try treating the agent
 * name directly as the instance name.
 */
function agentDataDir(agentName: string): string {
  return `${ARMADA_INSTANCES_DIR}/${agentName}`;
}

/**
 * file.share — Copy a file from an agent's data volume to the shared staging
 * area.  Returns { ref, filename, marker } so the caller can later deliver it.
 *
 * Params: { agent: string; path: string }
 */
async function handleFileShare(msg: CommandMessage): Promise<ResponseMessage> {
  const { agent, path: filePath } = msg.params as { agent: string; path: string };
  if (!agent || !filePath) {
    return {
      type: 'response', id: msg.id, status: 'error',
      error: 'agent and path are required', code: WsErrorCode.UNKNOWN,
    };
  }

  // Resolve source path — either absolute within DATA_DIR or relative to agent data dir
  let sourcePath: string;
  if (filePath.startsWith('/')) {
    sourcePath = resolve(filePath);
    const normalizedDataDir = resolve(DATA_DIR);
    if (!sourcePath.startsWith(normalizedDataDir + '/') && sourcePath !== normalizedDataDir) {
      return {
        type: 'response', id: msg.id, status: 'error',
        error: 'Path outside data directory', code: WsErrorCode.PERMISSION_DENIED,
      };
    }
  } else {
    sourcePath = resolve(agentDataDir(agent), filePath);
  }

  // Verify file exists
  let fileInfo: Awaited<ReturnType<typeof stat>>;
  try {
    fileInfo = await stat(sourcePath);
  } catch (err: any) {
    console.warn('[files] Source file not found:', err.message);
    return {
      type: 'response', id: msg.id, status: 'error',
      error: `File not found: ${sourcePath}`, code: WsErrorCode.FILE_NOT_FOUND,
    };
  }

  if (!fileInfo.isFile()) {
    return {
      type: 'response', id: msg.id, status: 'error',
      error: 'Path is not a file', code: WsErrorCode.UNKNOWN,
    };
  }

  const ref = randomUUID();
  const filename = basename(sourcePath);
  const destDir = `${SHARED_FILES_DIR}/${ref}`;
  await mkdir(destDir, { recursive: true });
  const destPath = `${destDir}/${filename}`;
  await copyFile(sourcePath, destPath);

  // Write metadata so deliver can find the original filename
  await writeFile(`${destDir}/.meta.json`, JSON.stringify({
    ref,
    filename,
    fromAgent: agent,
    originalPath: sourcePath,
    size: fileInfo.size,
    createdAt: new Date().toISOString(),
  }));

  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: {
      ref,
      filename,
      marker: ref,
      size: fileInfo.size,
    },
  };
}

/**
 * file.deliver — Copy a previously shared file from the staging area into a
 * target agent's data volume.
 *
 * Params: { ref: string; toAgent: string; destPath?: string }
 */
async function handleFileDeliver(msg: CommandMessage): Promise<ResponseMessage> {
  const { ref, toAgent, destPath } = msg.params as {
    ref: string;
    toAgent: string;
    destPath?: string;
  };

  if (!ref || !toAgent) {
    return {
      type: 'response', id: msg.id, status: 'error',
      error: 'ref and toAgent are required', code: WsErrorCode.UNKNOWN,
    };
  }

  // Locate the staged file
  const stageDir = `${SHARED_FILES_DIR}/${ref}`;
  let meta: { filename: string };
  try {
    meta = JSON.parse(await readFile(`${stageDir}/.meta.json`, 'utf-8'));
  } catch (err: any) {
    console.warn('[files] Failed to parse staged file meta:', err.message);
    return {
      type: 'response', id: msg.id, status: 'error',
      error: `Shared file not found for ref: ${ref}`, code: WsErrorCode.FILE_NOT_FOUND,
    };
  }

  const stagedFile = `${stageDir}/${meta.filename}`;

  // Determine destination — relative to agent data dir
  const targetBase = agentDataDir(toAgent);
  const relDest = destPath || `workspace/${meta.filename}`;
  const targetPath = relDest.startsWith('/')
    ? resolve(targetBase, relDest.slice(1))
    : resolve(targetBase, relDest);

  // Ensure target dir exists
  const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
  await mkdir(targetDir, { recursive: true });

  await copyFile(stagedFile, targetPath);

  // The path inside the container (mounted at /home/node/.openclaw)
  const containerPath = `/home/node/.openclaw/${relDest.startsWith('/') ? relDest.slice(1) : relDest}`;

  return {
    type: 'response',
    id: msg.id,
    status: 'ok',
    data: {
      delivered: meta.filename,
      toAgent,
      targetPath,
      containerPath,
      ref,
    },
  };
}

/**
 * file.list — List files for an agent's data volume, or at a given path.
 * Supports params: { agent: string } or { path: string }
 */
async function handleFileListAgent(msg: CommandMessage): Promise<ResponseMessage> {
  const params = msg.params as { agent?: string; path?: string };

  let resolved: string;
  if (params.agent && !params.path) {
    // List shared files staged for this agent
    resolved = SHARED_FILES_DIR;
  } else if (params.path) {
    resolved = validatePath(params.path);
  } else {
    return {
      type: 'response', id: msg.id, status: 'error',
      error: 'agent or path is required', code: WsErrorCode.UNKNOWN,
    };
  }

  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (entry) => {
        let size = 0;
        try {
          const s = await stat(resolve(resolved, entry.name));
          size = s.size;
        } catch (err: any) { console.warn('[files] stat failed:', err.message); }
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size,
        };
      }),
    );
    return { type: 'response', id: msg.id, status: 'ok', data: { entries: items } };
  } catch (err: any) {
    console.warn('[files] Failed to list directory entries:', err.message);
    return { type: 'response', id: msg.id, status: 'ok', data: { entries: [] } };
  }
}

export async function handleFileCommand(msg: CommandMessage): Promise<ResponseMessage> {
  try {
    switch (msg.action) {
      case 'file.read':     return await handleFileRead(msg);
      case 'file.write':    return await handleFileWrite(msg);
      case 'file.list':     return (msg.params as any)?.agent && !(msg.params as any)?.path
        ? await handleFileListAgent(msg)
        : await handleFileList(msg);
      case 'file.delete':   return await handleFileDelete(msg);
      case 'file.download': return await handleFileDownload(msg);
      case 'file.share':    return await handleFileShare(msg);
      case 'file.deliver':  return await handleFileDeliver(msg);
      default:
        return {
          type: 'response',
          id: msg.id,
          status: 'error',
          error: `Unknown file action: ${msg.action}`,
          code: WsErrorCode.UNKNOWN,
        };
    }
  } catch (err) {
    return errorResponse(msg, err);
  }
}
