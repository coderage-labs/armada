const PORT_RANGE_START = 4833;
const PORT_RANGE_END = 4899;

/**
 * Find the next available port in the fleet range.
 * @param usedPorts - Array of ports already in use
 * @returns The next available port
 * @throws If all ports in the range are exhausted
 */
export function allocatePort(usedPorts: number[]): number {
  const used = new Set(usedPorts);
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (!used.has(port)) {
      return port;
    }
  }
  throw new Error(
    `All ports exhausted in range ${PORT_RANGE_START}-${PORT_RANGE_END}`,
  );
}

export { PORT_RANGE_START, PORT_RANGE_END };
