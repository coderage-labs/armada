/**
 * Version checker service — polls GitHub releases for the latest OpenClaw and Armada versions.
 * Uses ETag/If-None-Match to minimize API calls against GitHub rate limits.
 */

const OPENCLAW_RELEASES_URL = 'https://api.github.com/repos/openclaw/openclaw/releases/latest';
const ARMADA_RELEASES_URL = 'https://api.github.com/repos/coderage-labs/armada/releases/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let latestOpenClawVersion: string | null = null;
let openClawEtag: string | null = null;

let latestArmadaVersion: string | null = null;
let armadaEtag: string | null = null;
let armadaReleaseUrl: string | null = null;
let armadaReleaseNotes: string | null = null;

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

async function checkOpenClawVersion(): Promise<void> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'armada',
    };
    if (openClawEtag) {
      headers['If-None-Match'] = openClawEtag;
    }
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken) {
      headers['Authorization'] = `Bearer ${ghToken}`;
    }

    const resp = await fetch(OPENCLAW_RELEASES_URL, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (resp.status === 304) {
      return;
    }

    if (!resp.ok) {
      console.warn(`[version-checker] OpenClaw GitHub API returned ${resp.status}`);
      return;
    }

    const newEtag = resp.headers.get('etag');
    if (newEtag) {
      openClawEtag = newEtag;
    }

    const data = await resp.json() as { tag_name?: string };
    if (!data.tag_name) {
      console.warn('[version-checker] No tag_name in OpenClaw release response');
      return;
    }

    const version = parseTag(data.tag_name);
    if (version !== latestOpenClawVersion) {
      if (latestOpenClawVersion) {
        console.log(`[version-checker] New OpenClaw version detected: ${version} (was ${latestOpenClawVersion})`);
      } else {
        console.log(`[version-checker] Latest OpenClaw version: ${version}`);
      }
      latestOpenClawVersion = version;
    }
  } catch (err: any) {
    console.warn(`[version-checker] OpenClaw check failed: ${err.message}`);
  }
}

async function checkArmadaVersion(): Promise<void> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'armada',
    };
    if (armadaEtag) {
      headers['If-None-Match'] = armadaEtag;
    }
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken) {
      headers['Authorization'] = `Bearer ${ghToken}`;
    }

    const resp = await fetch(ARMADA_RELEASES_URL, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (resp.status === 304) {
      return;
    }

    if (!resp.ok) {
      console.warn(`[version-checker] Armada GitHub API returned ${resp.status}`);
      return;
    }

    const newEtag = resp.headers.get('etag');
    if (newEtag) {
      armadaEtag = newEtag;
    }

    const data = await resp.json() as { tag_name?: string; html_url?: string; body?: string };
    if (!data.tag_name) {
      console.warn('[version-checker] No tag_name in Armada release response');
      return;
    }

    const version = parseTag(data.tag_name);
    const url = data.html_url ?? `https://github.com/coderage-labs/armada/releases/tag/${data.tag_name}`;
    const notes = data.body ?? null;

    if (version !== latestArmadaVersion) {
      const wasVersion = latestArmadaVersion;
      latestArmadaVersion = version;
      armadaReleaseUrl = url;
      armadaReleaseNotes = notes;

      if (wasVersion) {
        console.log(`[version-checker] New Armada version detected: ${version} (was ${wasVersion})`);
        // Trigger notification on update detection
        await notifyArmadaUpdate(version, wasVersion, url);
      } else {
        console.log(`[version-checker] Latest Armada version: ${version}`);
      }
    }
  } catch (err: any) {
    console.warn(`[version-checker] Armada check failed: ${err.message}`);
  }
}

async function notifyArmadaUpdate(latest: string, current: string, releaseUrl: string): Promise<void> {
  try {
    // Import dynamically to avoid circular dependency
    const { sendNotification } = await import('./notification-service.js');
    await sendNotification({
      event: 'armada.update_available',
      message: `Armada update available: v${latest} (currently v${current}). Release: ${releaseUrl}`,
      data: { latest, current, releaseUrl },
    });
  } catch (err: any) {
    console.warn(`[version-checker] Failed to send update notification: ${err.message}`);
  }
}

/** Get the latest known OpenClaw version, or null if not yet checked. */
export function getLatestVersion(): string | null {
  return latestOpenClawVersion;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl?: string;
  releaseNotes?: string;
}

/** Get Armada version info for API consumption */
export async function getArmadaVersionInfo(): Promise<VersionInfo> {
  // Import to get current version
  const { CONTROL_VERSION } = await import('../version.js');
  
  return {
    current: CONTROL_VERSION,
    latest: latestArmadaVersion,
    updateAvailable: !!(latestArmadaVersion && isNewerVersion(latestArmadaVersion, CONTROL_VERSION)),
    releaseUrl: armadaReleaseUrl ?? undefined,
    releaseNotes: armadaReleaseNotes ?? undefined,
  };
}

/** Start the version checker (polls every 6 hours). */
export function startVersionChecker(): void {
  if (timer) return; // Already running
  console.log('[version-checker] Starting (6h interval)');
  // Check immediately on start
  void checkOpenClawVersion();
  void checkArmadaVersion();
  timer = setInterval(() => {
    void checkOpenClawVersion();
    void checkArmadaVersion();
  }, CHECK_INTERVAL_MS);
}

/** Stop the version checker. */
export function stopVersionChecker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[version-checker] Stopped');
  }
}
