import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, authed } from '../../test/setup-integration.js';

describe('Instances API', () => {
  let baseUrl: string;
  let token: string;
  let close: () => void;
  let nodeId: string;

  beforeAll(async () => {
    const s = await startTestServer();
    baseUrl = s.baseUrl;
    token = s.ctx.token;
    close = s.close;

    // Get the test node ID
    const nodesRes = await fetch(`${baseUrl}/api/nodes`, { headers: authed(token) });
    const nodes = await nodesRes.json();
    nodeId = nodes[0].id;
  });

  afterAll(() => close());

  it('POST /api/instances stages a create in working copy', async () => {
    // Discard any prior draft state to avoid conflicts
    await fetch(`${baseUrl}/api/draft/discard`, {
      method: 'POST',
      headers: authed(token),
    });

    const res = await fetch(`${baseUrl}/api/instances`, {
      method: 'POST',
      headers: authed(token),
      body: JSON.stringify({ name: 'test-instance', nodeId, capacity: 3 }),
    });
    // Working copy pipeline: create always returns 200 (staging is independent of node state)
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe('create');

    // Clean up draft state
    await fetch(`${baseUrl}/api/draft/discard`, {
      method: 'POST',
      headers: authed(token),
    });
  });

  it('GET /api/instances lists instances', async () => {
    const res = await fetch(`${baseUrl}/api/instances`, { headers: authed(token) });
    expect(res.status).toBe(200);
    const instances = await res.json();
    expect(Array.isArray(instances)).toBe(true);
  });

  it('GET /api/draft/diff shows staged instance after create', async () => {
    // Discard any prior draft state
    await fetch(`${baseUrl}/api/draft/discard`, {
      method: 'POST',
      headers: authed(token),
    });

    const createRes = await fetch(`${baseUrl}/api/instances`, {
      method: 'POST',
      headers: authed(token),
      body: JSON.stringify({ name: 'test-get-inst', nodeId }),
    });
    expect(createRes.status).toBe(200);
    const body = await createRes.json();
    expect(body.ok).toBe(true);

    // Staged entity should appear in draft diff
    const diffRes = await fetch(`${baseUrl}/api/draft/diff`, { headers: authed(token) });
    expect(diffRes.status).toBe(200);
    const diff = await diffRes.json();
    expect(diff.hasChanges).toBe(true);
    const stagedInstance = diff.diffs?.find((d: any) => d.type === 'instance' && d.action === 'create');
    expect(stagedInstance).toBeTruthy();
    expect(stagedInstance?.type).toBe('instance');
    expect(stagedInstance?.action).toBe('create');
    // fields is null for creates (all data is new, no diff to show)

    // Staged entity is NOT in the committed DB yet
    const getRes = await fetch(`${baseUrl}/api/instances/${stagedInstance.id}`, {
      headers: authed(token),
    });
    expect(getRes.status).toBe(404);

    // Clean up
    await fetch(`${baseUrl}/api/draft/discard`, {
      method: 'POST',
      headers: authed(token),
    });
  });

  it('DELETE /api/instances/:id stages instance deletion', async () => {
    // Create an instance directly in DB (bypass working copy) so we have something to delete
    const { instancesRepo } = await import('../../repositories/index.js');
    const instance = instancesRepo.create({
      name: 'test-destroy',
      nodeId,
      status: 'running',
      capacity: 5,
    } as any);

    // Discard any prior draft state so DELETE can proceed (no open changesets)
    await fetch(`${baseUrl}/api/draft/discard`, {
      method: 'POST',
      headers: authed(token),
    });

    const res = await fetch(`${baseUrl}/api/instances/${instance.id}?confirm=true`, {
      method: 'DELETE',
      headers: authed(token),
    });
    // Delete stages via working copy — returns 200 with { ok: true, action: 'delete' }
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe('delete');

    // Clean up draft state
    await fetch(`${baseUrl}/api/draft/discard`, {
      method: 'POST',
      headers: authed(token),
    });
  });
});
