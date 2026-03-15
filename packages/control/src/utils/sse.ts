import type { Response } from 'express';

export function setupSSE(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',       // Nginx
    'X-Content-Type-Options': 'nosniff',
  });
  res.flushHeaders();

  // Send initial comment to confirm connection
  res.write(':ok\n\n');

  // Heartbeat every 15s to keep connection alive through proxies
  // (Cloudflare has 100s idle timeout, but mobile browsers can be aggressive)
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 15_000);

  res.on('close', () => clearInterval(heartbeat));

  return {
    send: (event: string, data: any, id?: number) => {
      // Include event type in data payload so onmessage handlers can read it
      // (named SSE events bypass onmessage — only addEventListener catches them)
      const payload = typeof data === 'object' && data !== null
        ? { ...data, event }
        : { event, data };
      let msg = '';
      if (id !== undefined) msg += `id: ${id}\n`;
      msg += `data: ${JSON.stringify(payload)}\n\n`;
      res.write(msg);
    },
    close: () => {
      clearInterval(heartbeat);
      res.end();
    },
  };
}
