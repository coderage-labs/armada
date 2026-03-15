import { WsNodeClient } from './infrastructure/ws-node-client.js';

export { WsNodeClient as NodeClient };

interface NodeEntry {
  id: string;
  client: WsNodeClient;
}

export class NodeManager {
  private entries = new Map<string, NodeEntry>();

  /**
   * Register a node by ID. url/token are no longer needed — communication
   * goes through the WS command dispatcher. Kept as optional parameters
   * for backwards compatibility with call sites that pass them.
   */
  addNode(id: string, _url?: string, _token?: string): void {
    this.entries.set(id, { id, client: new WsNodeClient(id) });
  }

  getNode(id: string): WsNodeClient | undefined {
    return this.entries.get(id)?.client;
  }

  getNodeId(id: string): string | undefined {
    return this.entries.get(id)?.id;
  }

  /** For single-host setups, get the default (first registered) node. */
  getDefaultNode(): WsNodeClient {
    const first = this.entries.values().next();
    if (first.done) {
      throw new Error('No nodes registered in NodeManager');
    }
    return first.value.client;
  }

  /** Get the ID of the default (first registered) node. */
  getDefaultNodeId(): string {
    const first = this.entries.values().next();
    if (first.done) {
      throw new Error('No nodes registered in NodeManager');
    }
    return first.value.id;
  }

  getAllNodes(): WsNodeClient[] {
    return Array.from(this.entries.values()).map(e => e.client);
  }

  removeNode(id: string): boolean {
    return this.entries.delete(id);
  }

  hasNode(id: string): boolean {
    return this.entries.has(id);
  }

  get size(): number {
    return this.entries.size;
  }
}
