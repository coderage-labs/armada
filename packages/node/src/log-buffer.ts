/**
 * Ring buffer logger — captures console output for the node agent.
 * Logs are accessible via the `node.logs` WS command.
 */

const MAX_ENTRIES = 500;
const buffer: Array<{ timestamp: string; level: string; message: string }> = [];

export function addLog(level: string, message: string): void {
  buffer.push({ timestamp: new Date().toISOString(), level, message });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

export function getLogs(limit = 100, since?: string): Array<{ timestamp: string; level: string; message: string }> {
  let filtered = buffer;
  if (since) {
    filtered = buffer.filter(l => l.timestamp > since);
  }
  return filtered.slice(-limit);
}

// Monkey-patch console to capture logs
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args: any[]) => {
  addLog('info', args.map(String).join(' '));
  origLog(...args);
};

console.warn = (...args: any[]) => {
  addLog('warn', args.map(String).join(' '));
  origWarn(...args);
};

console.error = (...args: any[]) => {
  addLog('error', args.map(String).join(' '));
  origError(...args);
};
