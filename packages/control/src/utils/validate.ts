const NAME_REGEX = /^[a-z0-9-]+$/;
const PORT_MIN = 4833;
const PORT_MAX = 4899;
const MEMORY_MAX_BYTES = 16 * 1024 ** 3; // 16g
const CPUS_MAX = 8;

export function isValidName(name: string): boolean {
  return NAME_REGEX.test(name) && name.length > 0 && name.length <= 63;
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX;
}

function parseMemoryToBytes(mem: string): number {
  const match = mem.match(/^(\d+(?:\.\d+)?)\s*([kmgt])?b?$/i);
  if (!match) return -1;
  const value = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  const multipliers: Record<string, number> = {
    '': 1,
    k: 1024,
    m: 1024 ** 2,
    g: 1024 ** 3,
    t: 1024 ** 4,
  };
  return Math.floor(value * (multipliers[unit] ?? 1));
}

export function isValidMemory(mem: string): boolean {
  const bytes = parseMemoryToBytes(mem);
  return bytes > 0 && bytes <= MEMORY_MAX_BYTES;
}

export function isValidCpus(cpus: string): boolean {
  const n = parseFloat(cpus);
  return !isNaN(n) && n > 0 && n <= CPUS_MAX;
}
