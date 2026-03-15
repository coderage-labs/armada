/**
 * Port pool — allocates host ports for instance containers.
 * Persists allocations to disk so they survive node agent restarts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT_RANGE_START = parseInt(process.env.PORT_RANGE_START ?? '18800', 10);
const PORT_RANGE_END = parseInt(process.env.PORT_RANGE_END ?? '18899', 10);
const STATE_FILE = process.env.PORT_STATE_FILE ?? '/data/port-allocations.json';

interface PortState {
  allocations: Record<string, number>; // containerName → port
}

let state: PortState = { allocations: {} };

function load(): void {
  try {
    if (existsSync(STATE_FILE)) {
      state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {
    state = { allocations: {} };
  }
}

function save(): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[port-pool] Failed to save state:', err);
  }
}

/** Allocate the next free port for a container. Returns existing allocation if already assigned. */
export function allocatePort(containerName: string): number {
  load();
  // Return existing allocation
  if (state.allocations[containerName]) {
    return state.allocations[containerName];
  }

  const usedPorts = new Set(Object.values(state.allocations));
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (!usedPorts.has(port)) {
      state.allocations[containerName] = port;
      save();
      return port;
    }
  }
  throw new Error(`All ports exhausted in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

/** Release a port allocation. */
export function releasePort(containerName: string): void {
  load();
  delete state.allocations[containerName];
  save();
}

/** Get the allocated port for a container, or null. */
export function getPort(containerName: string): number | null {
  load();
  return state.allocations[containerName] ?? null;
}

/** Get all current allocations. */
export function getAllocations(): Record<string, number> {
  load();
  return { ...state.allocations };
}

export { PORT_RANGE_START, PORT_RANGE_END };
