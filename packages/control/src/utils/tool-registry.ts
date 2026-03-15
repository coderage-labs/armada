/**
 * Tool metadata registry.
 *
 * API routes register their operations as tool definitions.
 * Armada control fetches these at startup and auto-registers LLM tools.
 */

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface ToolDefinition {
  /** Tool name (e.g. 'armada_restart') */
  name: string;
  /** Human-readable description for the LLM */
  description: string;
  /** HTTP method */
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  /** API path with :param placeholders (e.g. '/api/agents/:name/restart') */
  path: string;
  /** Parameters — mapped to path params, query params, or body fields */
  parameters: ToolParameter[];
  /** Whether this tool returns plain text (logs) instead of JSON */
  responseFormat?: 'json' | 'text';
  /** If true, the tool supports "all" as a target to operate on every agent */
  supportsAll?: boolean;
}

const _tools: ToolDefinition[] = [];

/**
 * Register a tool definition. Called by route setup functions.
 */
export function registerToolDef(def: ToolDefinition): void {
  _tools.push(def);
}

/**
 * Get all registered tool definitions.
 */
export function getToolDefs(): ToolDefinition[] {
  return [..._tools];
}
