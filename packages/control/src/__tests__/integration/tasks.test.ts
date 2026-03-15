import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, authed } from '../../test/setup-integration.js';

describe('Tasks API', () => {
  let baseUrl: string;
  let token: string;
  let close: () => void;
  const createdTaskIds: string[] = [];

  beforeAll(async () => {
    const s = await startTestServer();
    baseUrl = s.baseUrl;
    token = s.ctx.token;
    close = s.close;
  });

  afterAll(async () => {
    // Delete all tasks created during tests
    for (const id of createdTaskIds) {
      try {
        await fetch(`${baseUrl}/api/tasks/${id}`, {
          method: 'DELETE',
          headers: authed(token),
        });
      } catch {
        // ignore
      }
    }
    close();
  });

  it('POST /api/tasks creates a task', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: authed(token),
      body: JSON.stringify({ fromAgent: 'operator', toAgent: 'forge', taskText: 'Build a thing' }),
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.taskText).toBe('Build a thing');
    expect(task.status).toBe('pending');
    createdTaskIds.push(task.id);
  });

  it('GET /api/tasks lists tasks', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, { headers: authed(token) });
    expect(res.status).toBe(200);
    const tasks = await res.json();
    expect(Array.isArray(tasks)).toBe(true);
  });

  it('PUT /api/tasks/:id updates and completes a task', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: authed(token),
      body: JSON.stringify({ fromAgent: 'operator', toAgent: 'forge', taskText: 'Test complete' }),
    });
    const task = await createRes.json();
    createdTaskIds.push(task.id);

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: 'PUT',
      headers: authed(token),
      body: JSON.stringify({ status: 'completed', result: 'All done' }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe('completed');
    expect(updated.result).toBe('All done');
  });

  it('GET /api/tasks?status=completed filters by status', async () => {
    const res = await fetch(`${baseUrl}/api/tasks?status=completed`, { headers: authed(token) });
    expect(res.status).toBe(200);
    const tasks = await res.json();
    expect(tasks.every((t: any) => t.status === 'completed')).toBe(true);
  });
});
