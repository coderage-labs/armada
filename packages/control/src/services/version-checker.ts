/**
 * Version checker service — polls GitHub releases for the latest OpenClaw version.
 * Uses ETag/If-None-Match to minimize API calls against GitHub rate limits.
 */

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/openclaw/openclaw/releases/latest';
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let latestVersion: string | null = null;
let etag: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Compare two OpenClaw versions (YYYY.M.P format).
 * Returns true if `a` is newer than `b`.
 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

/** Parse tag name from GitHub release (e.g. "v2026.3.8" → "2026.3.8") */
function parseTag(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

async function checkLatestVersion(): Promise<void> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'armada',
    };
    if (etag) {
      headers['If-None-Match'] = etag;
    }
    // Use GitHub token if available to increase rate limit
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken) {
      headers['Authorization'] = `Bearer ${ghToken}`;
    }

    const resp = await fetch(GITHUB_RELEASES_URL, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (resp.status === 304) {
      // Not modified — current version is still latest
      return;
    }

    if (!resp.ok) {
      console.warn(`[version-checker] GitHub API returned ${resp.status}`);
      return;
    }

    // Store ETag for next request
    const newEtag = resp.headers.get('etag');
    if (newEtag) {
      etag = newEtag;
    }

    const data = await resp.json() as { tag_name?: string };
    if (!data.tag_name) {
      console.warn('[version-checker] No tag_name in release response');
      return;
    }

    const version = parseTag(data.tag_name);
    if (version !== latestVersion) {
      if (latestVersion) {
        console.log(`[version-checker] New version detected: ${version} (was ${latestVersion})`);
      } else {
        console.log(`[version-checker] Latest version: ${version}`);
      }
      latestVersion = version;
    }
  } catch (err: any) {
    console.warn(`[version-checker] Check failed: ${err.message}`);
  }
}

/** Get the latest known OpenClaw version, or null if not yet checked. */
export function getLatestVersion(): string | null {
  return latestVersion;
}

/** Start the version checker (polls every 30 minutes). */
export function startVersionChecker(): void {
  if (timer) return; // Already running
  console.log('[version-checker] Starting (30min interval)');
  // Check immediately on start
  checkLatestVersion();
  timer = setInterval(checkLatestVersion, CHECK_INTERVAL_MS);
}

/** Stop the version checker. */
export function stopVersionChecker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[version-checker] Stopped');
  }
}
