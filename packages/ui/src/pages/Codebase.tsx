import { useCallback, useEffect, useState, useMemo } from 'react';
import { Search, RefreshCw, Database, Loader2, AlertCircle, Code2, FileCode, GitBranch } from 'lucide-react';
import { apiFetch } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { toast } from 'sonner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  useNodesState,
  useEdgesState,
  ConnectionLineType,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

/* ── Types ─────────────────────────────────────────── */

interface SymbolResult {
  id: string;
  fileId: string;
  name: string;
  kind: string;
  line: number;
  signature?: string;
  exported?: boolean;
}

interface FileResult {
  id: string;
  path: string;
  language: string;
  size: number;
  lineCount: number;
}

interface SearchResponse {
  files: FileResult[];
  symbols: SymbolResult[];
}

interface DependencyImport {
  module: string;
  symbols: string[];
  resolvedFile?: { id: string; path: string; language: string };
}

interface DependencyResponse {
  file: { id: string; path: string; language: string };
  imports: DependencyImport[];
  importedBy: DependencyImport[];
}

interface ArchitectureResponse {
  files: number;
  symbols: number;
  imports: number;
  languages: Record<string, number>;
  topLevelDirs: string[];
  mostImported: Array<{ path: string; importerCount: number }>;
}

interface IndexStatusResponse {
  indexed: boolean;
  lastIndexedAt?: string;
  fileCount?: number;
  symbolCount?: number;
  importCount?: number;
  languages?: Record<string, number>;
}

interface IndexResponse {
  fileCount: number;
  symbolCount: number;
  importCount: number;
  languages: Record<string, number>;
  durationMs: number;
  errors: string[];
}

interface FileContextResponse {
  file: { id: string; path: string; language: string; size: number; lineCount: number };
  symbols: SymbolResult[];
  imports: DependencyImport[];
  importedBy: DependencyImport[];
}

/* ── Helpers ───────────────────────────────────────── */

function getLanguageColor(language: string): string {
  const lang = language.toLowerCase();
  if (lang.includes('typescript') || lang === 'tsx') return '#3178c6';
  if (lang.includes('javascript') || lang === 'jsx') return '#b8860b'; // darker gold, readable with white text
  if (lang.includes('python')) return '#22c55e';
  if (lang.includes('go')) return '#00add8';
  if (lang.includes('rust')) return '#ce422b';
  if (lang.includes('java') && !lang.includes('javascript')) return '#e76f00';
  if (lang.includes('json')) return '#8b6914'; // darker gold
  if (lang.includes('yaml') || lang.includes('yml')) return '#cb171e';
  if (lang.includes('terraform') || lang.includes('hcl') || lang.includes('tf')) return '#7b42bc';
  if (lang.includes('markdown') || lang.includes('md')) return '#a855f7';
  if (lang.includes('docker')) return '#2496ed';
  if (lang.includes('shell') || lang.includes('bash') || lang.includes('sh')) return '#4eaa25';
  if (lang.includes('css') || lang.includes('scss')) return '#264de4';
  if (lang.includes('html')) return '#e34c26';
  if (lang.includes('sql')) return '#336791';
  if (lang.includes('toml')) return '#9c4221';
  return '#6b7280';
}

function getKindBadgeColor(kind: string): string {
  switch (kind) {
    case 'function':
    case 'method':
      return 'bg-blue-500/20 border-blue-500/30 text-blue-300';
    case 'class':
      return 'bg-violet-500/20 border-violet-500/30 text-violet-300';
    case 'interface':
    case 'type':
      return 'bg-cyan-500/20 border-cyan-500/30 text-cyan-300';
    case 'const':
    case 'let':
    case 'var':
      return 'bg-amber-500/20 border-amber-500/30 text-amber-300';
    default:
      return 'bg-zinc-500/20 border-zinc-500/30 text-zinc-300';
  }
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ── Graph View ────────────────────────────────────── */

interface GraphViewProps {
  repo?: string;
  onFileSelect: (file: string) => void;
}

function GraphView({ repo, onFileSelect }: GraphViewProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    loadGraph();
  }, [repo]);

  async function loadGraph() {
    setLoading(true);
    try {
      const arch = await apiFetch<ArchitectureResponse>('/api/codebase/architecture', {
        method: 'POST',
        body: JSON.stringify({ repo: repo || undefined }),
      });

      // Use mostImported files as nodes
      const topFiles = arch.mostImported.slice(0, 50); // Limit to 50 nodes for performance

      const nodeMap = new Map<string, { x: number; y: number; language: string }>();
      const newNodes: Node[] = [];
      const newEdges: Edge[] = [];

      // Create nodes in a circular layout
      const radius = 300;
      const angleStep = (2 * Math.PI) / topFiles.length;

      topFiles.forEach((item, idx) => {
        const angle = idx * angleStep;
        const x = 500 + radius * Math.cos(angle);
        const y = 400 + radius * Math.sin(angle);

        // Infer language from file extension
        const ext = item.path.split('.').pop() || '';
        let language = 'other';
        if (['ts', 'tsx'].includes(ext)) language = 'typescript';
        else if (['js', 'jsx'].includes(ext)) language = 'javascript';
        else if (ext === 'py') language = 'python';
        else if (ext === 'go') language = 'go';
        else if (ext === 'json') language = 'json';
        else if (ext === 'md') language = 'markdown';

        nodeMap.set(item.path, { x, y, language });

        newNodes.push({
          id: item.path,
          type: 'default',
          position: { x, y },
          data: {
            label: item.path.split('/').pop() || item.path,
          },
          style: {
            background: getLanguageColor(language),
            color: '#fff',
            border: '2px solid #fff',
            fontSize: 11,
            padding: '6px 10px',
            borderRadius: 8,
          },
        });
      });

      // Fetch dependencies for each file and create edges
      for (const item of topFiles) {
        try {
          const deps = await apiFetch<DependencyResponse>('/api/codebase/dependencies', {
            method: 'POST',
            body: JSON.stringify({ file: item.path, repo: repo || undefined }),
          });

          deps.imports.forEach((imp) => {
            const targetPath = imp.resolvedFile?.path;
            if (targetPath && nodeMap.has(targetPath)) {
              const edgeId = `${item.path}-${targetPath}`;
              if (!newEdges.some(e => e.id === edgeId)) {
                newEdges.push({
                  id: edgeId,
                  source: item.path,
                  target: targetPath,
                  type: ConnectionLineType.Bezier,
                  style: { stroke: '#6b7280', strokeWidth: 1 },
                  animated: false,
                });
              }
            }
          });
        } catch {
          // Skip files with no dependencies
        }
      }

      setNodes(newNodes);
      setEdges(newEdges);
    } catch (err: any) {
      toast.error(`Failed to load graph: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  function handleNodeClick(event: React.MouseEvent, node: Node) {
    setSelectedFile(node.id);
    onFileSelect(node.id);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
        <span className="ml-2 text-sm text-zinc-500">Loading dependency graph...</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden" style={{ height: '600px' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        fitView
        className="bg-zinc-950"
      >
        <Background color="#27272a" gap={16} />
        <Controls className="bg-zinc-800 border border-zinc-700" />
        <MiniMap className="bg-zinc-900 border border-zinc-700" nodeColor={(n) => n.style?.background as string || '#6b7280'} />
        <Panel position="top-left" className="bg-zinc-800/90 backdrop-blur border border-zinc-700 rounded-lg p-3 text-xs text-zinc-300">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full" style={{ background: getLanguageColor('typescript') }} />
              <span>TypeScript</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full" style={{ background: getLanguageColor('javascript') }} />
              <span>JavaScript</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full" style={{ background: getLanguageColor('python') }} />
              <span>Python</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full" style={{ background: getLanguageColor('go') }} />
              <span>Go</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full" style={{ background: getLanguageColor('json') }} />
              <span>JSON</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full" style={{ background: getLanguageColor('other') }} />
              <span>Other</span>
            </div>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}

/* ── Architecture Overview ─────────────────────────── */

interface ArchitectureOverviewProps {
  repo?: string;
}

function ArchitectureOverview({ repo }: ArchitectureOverviewProps) {
  const [arch, setArch] = useState<ArchitectureResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadArchitecture();
  }, [repo]);

  async function loadArchitecture() {
    setLoading(true);
    try {
      const data = await apiFetch<ArchitectureResponse>('/api/codebase/architecture', {
        method: 'POST',
        body: JSON.stringify({ repo: repo || undefined }),
      });
      setArch(data);
    } catch (err: any) {
      toast.error(`Failed to load architecture: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  if (loading || !arch) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
      </div>
    );
  }

  const languageData = Object.entries(arch.languages).map(([lang, count]) => ({
    name: lang,
    value: count,
    color: getLanguageColor(lang),
  }));

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div className="text-[10px] uppercase text-zinc-600 tracking-wider">Files</div>
          <div className="text-2xl font-bold text-zinc-100 mt-1">{arch.files.toLocaleString()}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div className="text-[10px] uppercase text-zinc-600 tracking-wider">Symbols</div>
          <div className="text-2xl font-bold text-violet-300 mt-1">{arch.symbols.toLocaleString()}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div className="text-[10px] uppercase text-zinc-600 tracking-wider">Imports</div>
          <div className="text-2xl font-bold text-blue-300 mt-1">{arch.imports.toLocaleString()}</div>
        </div>
      </div>

      {/* Language distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Language Distribution</h3>
          {languageData.length === 0 ? (
            <p className="text-sm text-zinc-600">No language data available</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={languageData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name} ${((percent || 0) * 100).toFixed(0)}%`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {languageData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <RechartsTooltip
                  contentStyle={{
                    backgroundColor: '#18181b',
                    border: '1px solid #3f3f46',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: '#e4e4e7',
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Most imported files */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">Most Imported Files</h3>
          {arch.mostImported.length === 0 ? (
            <p className="text-sm text-zinc-600">No import data available</p>
          ) : (
            <div className="space-y-2">
              {arch.mostImported.slice(0, 10).map((item, idx) => (
                <div key={item.path} className="flex items-center justify-between py-2 px-3 rounded-lg bg-zinc-800/50 hover:bg-zinc-800 transition-colors">
                  <span className="text-xs text-zinc-300 truncate flex-1 font-mono">{item.path.split('/').pop()}</span>
                  <Badge variant="secondary" className="ml-2 shrink-0 bg-violet-500/20 text-violet-300 text-[10px]">
                    {item.importerCount}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Symbol Search ─────────────────────────────────── */

interface SymbolSearchProps {
  repo?: string;
  onFileSelect: (file: string) => void;
}

function SymbolSearch({ repo, onFileSelect }: SymbolSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);

  async function handleSearch() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const data = await apiFetch<SearchResponse>('/api/codebase/search', {
        method: 'POST',
        body: JSON.stringify({ query, repo: repo || undefined }),
      });
      setResults(data);
    } catch (err: any) {
      toast.error(`Search failed: ${err.message}`);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Search input */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search symbols, files..."
            className="pl-9 pr-3 py-2 rounded-lg bg-zinc-800/50 border border-zinc-800 text-sm text-zinc-200 focus:outline-none focus:border-violet-500/50"
          />
        </div>
        <Button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium disabled:opacity-40"
        >
          {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
        </Button>
      </div>

      {/* Results */}
      {results && (
        <div className="space-y-4">
          {/* Symbols */}
          {results.symbols.length > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <h3 className="text-sm font-semibold text-zinc-300 mb-3">
                Symbols ({results.symbols.length})
              </h3>
              <div className="space-y-2">
                {results.symbols.map((sym, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between py-2 px-3 rounded-lg bg-zinc-800/50 hover:bg-zinc-800 transition-colors cursor-pointer"
                    onClick={() => onFileSelect(sym.fileId)}
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className={`text-[10px] px-2 py-0.5 ${getKindBadgeColor(sym.kind)}`}>
                        {sym.kind}
                      </Badge>
                      <span className="text-sm font-medium text-zinc-200">{sym.name}</span>
                      <span className="text-xs text-zinc-600">@{sym.line}</span>
                    </div>
                    <span className="text-xs text-zinc-500 font-mono truncate max-w-md">{sym.fileId}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Files */}
          {results.files.length > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <h3 className="text-sm font-semibold text-zinc-300 mb-3">
                Files ({results.files.length})
              </h3>
              <div className="space-y-2">
                {results.files.map((file, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between py-2 px-3 rounded-lg bg-zinc-800/50 hover:bg-zinc-800 transition-colors cursor-pointer"
                    onClick={() => onFileSelect(file.path)}
                  >
                    <span className="text-sm text-zinc-300 font-mono truncate flex-1">{file.path}</span>
                    <Badge variant="secondary" className="ml-2 shrink-0 text-[10px]" style={{ backgroundColor: getLanguageColor(file.language) }}>
                      {file.language}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {results.symbols.length === 0 && results.files.length === 0 && (
            <div className="text-center py-12 text-sm text-zinc-500">
              No results found for "{query}"
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Index Status ──────────────────────────────────── */

interface IndexStatusProps {
  repo?: string;
  onReindex: () => void;
}

function IndexStatus({ repo, onReindex }: IndexStatusProps) {
  const [status, setStatus] = useState<IndexStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [indexing, setIndexing] = useState(false);

  useEffect(() => {
    loadStatus();
  }, [repo]);

  async function loadStatus() {
    setLoading(true);
    try {
      const data = await apiFetch<IndexStatusResponse>('/api/codebase/index-status', {
        method: 'POST',
        body: JSON.stringify({ repo: repo || undefined }),
      });
      setStatus(data);
    } catch (err: any) {
      toast.error(`Failed to load index status: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleReindex() {
    setIndexing(true);
    try {
      const result = await apiFetch<IndexResponse>('/api/codebase/index', {
        method: 'POST',
        body: JSON.stringify({ repo: repo || undefined, force: true }),
      });
      toast.success(`Indexed ${result.fileCount} files, ${result.symbolCount} symbols in ${(result.durationMs / 1000).toFixed(1)}s`);
      await loadStatus();
      onReindex();
    } catch (err: any) {
      toast.error(`Indexing failed: ${err.message}`);
    } finally {
      setIndexing(false);
    }
  }

  if (loading || !status) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
      </div>
    );
  }

  const isStale = status.lastIndexedAt && Date.now() - new Date(status.lastIndexedAt).getTime() > 86400000;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-zinc-300">Index Status</h3>
          <Button
            onClick={handleReindex}
            disabled={indexing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium disabled:opacity-40"
          >
            {indexing ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Indexing...
              </>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                Re-index
              </>
            )}
          </Button>
        </div>

        {!status.indexed ? (
          <div className="text-center py-8">
            <AlertCircle className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">Not yet indexed</p>
            <p className="text-xs text-zinc-600 mt-1">Click "Re-index" to start</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Last indexed */}
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-500">Last indexed</span>
              <span className={`font-medium ${isStale ? 'text-amber-400' : 'text-zinc-300'}`}>
                {status.lastIndexedAt ? relativeTime(status.lastIndexedAt) : 'Never'}
                {isStale && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300">Stale</span>}
              </span>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-zinc-800/50 p-3">
                <div className="text-[10px] uppercase text-zinc-600 tracking-wider">Files</div>
                <div className="text-lg font-bold text-zinc-200 mt-1">{status.fileCount?.toLocaleString() || 0}</div>
              </div>
              <div className="rounded-lg bg-zinc-800/50 p-3">
                <div className="text-[10px] uppercase text-zinc-600 tracking-wider">Symbols</div>
                <div className="text-lg font-bold text-violet-300 mt-1">{status.symbolCount?.toLocaleString() || 0}</div>
              </div>
              <div className="rounded-lg bg-zinc-800/50 p-3">
                <div className="text-[10px] uppercase text-zinc-600 tracking-wider">Imports</div>
                <div className="text-lg font-bold text-blue-300 mt-1">{status.importCount?.toLocaleString() || 0}</div>
              </div>
            </div>

            {/* Languages */}
            {status.languages && Object.keys(status.languages).length > 0 && (
              <div>
                <h4 className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Languages</h4>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(status.languages).map(([lang, count]) => (
                    <Badge
                      key={lang}
                      variant="secondary"
                      className="text-[10px] px-2 py-0.5"
                      style={{ backgroundColor: getLanguageColor(lang) }}
                    >
                      {lang} ({count})
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── File Detail Sidebar ───────────────────────────── */

interface FileDetailProps {
  file: string;
  repo?: string;
  onClose: () => void;
}

function FileDetail({ file, repo, onClose }: FileDetailProps) {
  const [context, setContext] = useState<FileContextResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadContext();
  }, [file, repo]);

  async function loadContext() {
    setLoading(true);
    try {
      const data = await apiFetch<FileContextResponse>('/api/codebase/file-context', {
        method: 'POST',
        body: JSON.stringify({ file, repo: repo || undefined }),
      });
      setContext(data);
    } catch (err: any) {
      toast.error(`Failed to load file context: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  if (loading || !context) {
    return (
      <div className="fixed right-0 top-16 bottom-0 w-96 bg-zinc-900 border-l border-zinc-800 p-4 overflow-y-auto">
        <div className="flex items-center justify-center h-full">
          <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed right-0 top-16 bottom-0 w-96 bg-zinc-900 border-l border-zinc-800 p-4 overflow-y-auto z-50">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-zinc-300 truncate flex-1">{file.split('/').pop()}</h3>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 transition-colors text-xl leading-none"
        >
          ×
        </button>
      </div>

      <div className="space-y-4">
        {/* File path */}
        <div>
          <h4 className="text-[10px] uppercase text-zinc-600 tracking-wider mb-1">Path</h4>
          <p className="text-xs text-zinc-400 font-mono break-all">{file}</p>
        </div>

        {/* Symbols */}
        {context.symbols.length > 0 && (
          <div>
            <h4 className="text-[10px] uppercase text-zinc-600 tracking-wider mb-2">Symbols ({context.symbols.length})</h4>
            <div className="space-y-1">
              {context.symbols.map((sym, idx) => (
                <div key={idx} className="flex items-center gap-2 py-1.5 px-2 rounded-lg bg-zinc-800/50 text-xs">
                  <Badge variant="secondary" className={`text-[10px] px-1.5 py-0.5 ${getKindBadgeColor(sym.kind)}`}>
                    {sym.kind}
                  </Badge>
                  <span className="text-zinc-300 font-medium truncate flex-1">{sym.name}</span>
                  <span className="text-zinc-600 shrink-0">@{sym.line}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Imports */}
        {context.imports.length > 0 && (
          <div>
            <h4 className="text-[10px] uppercase text-zinc-600 tracking-wider mb-2">Imports ({context.imports.length})</h4>
            <div className="space-y-1">
              {context.imports.map((imp, idx) => (
                <div key={idx} className="py-1.5 px-2 rounded-lg bg-zinc-800/50 text-xs text-zinc-400 font-mono truncate">
                  <span className="text-zinc-300">{imp.module}</span>
                  {imp.symbols.length > 0 && (
                    <span className="text-zinc-600 ml-1">{'{'}{imp.symbols.join(', ')}{'}'}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Imported by */}
        {context.importedBy.length > 0 && (
          <div>
            <h4 className="text-[10px] uppercase text-zinc-600 tracking-wider mb-2">Imported By ({context.importedBy.length})</h4>
            <div className="space-y-1">
              {context.importedBy.map((imp, idx) => (
                <div key={idx} className="py-1.5 px-2 rounded-lg bg-zinc-800/50 text-xs text-zinc-400 font-mono truncate">
                  <span className="text-zinc-300">{imp.resolvedFile?.path || imp.module}</span>
                  {imp.symbols.length > 0 && (
                    <span className="text-zinc-600 ml-1">{'{'}{imp.symbols.join(', ')}{'}'}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────── */

interface RepoInfo {
  repoId: string;
  fullName: string;
  lastIndexedAt: string;
  fileCount: number;
  symbolCount: number;
  importCount: number;
}

export default function Codebase() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [loadingRepos, setLoadingRepos] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<RepoInfo[]>('/api/codebase/repos');
        setRepos(data);
        if (data.length > 0 && !selectedRepo) {
          setSelectedRepo(data[0].fullName);
        }
      } catch { /* ignore */ }
      setLoadingRepos(false);
    })();
  }, []);

  return (
    <div className="space-y-6 max-w-7xl">
      <PageHeader
        icon={Code2}
        title="Codebase"
        subtitle="Interactive codebase visualization and exploration"
      />

      {/* Repo selector */}
      <div className="flex items-center gap-4 overflow-hidden">
        <label className="text-sm text-zinc-400">Repository:</label>
        {loadingRepos ? (
          <span className="text-sm text-zinc-500">Loading repos...</span>
        ) : repos.length === 0 ? (
          <span className="text-sm text-zinc-500">No indexed repos. Index a repo first via the API.</span>
        ) : (
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-violet-500 max-w-full truncate"
          >
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName} ({r.fileCount} files, {r.symbolCount} symbols)
              </option>
            ))}
          </select>
        )}
      </div>

      {selectedRepo && (
        <>
          {/* Index status */}
          <IndexStatus repo={selectedRepo} onReindex={() => {}} />

          {/* Tabs */}
          <Tabs defaultValue="graph">
            <TabsList>
              <TabsTrigger value="graph" className="flex items-center gap-2">
                <GitBranch className="w-4 h-4" /> Dependency Graph
              </TabsTrigger>
              <TabsTrigger value="overview" className="flex items-center gap-2">
                <Database className="w-4 h-4" /> Architecture
              </TabsTrigger>
              <TabsTrigger value="search" className="flex items-center gap-2">
                <Search className="w-4 h-4" /> Symbol Search
              </TabsTrigger>
            </TabsList>

            <TabsContent value="graph">
              <GraphView repo={selectedRepo} onFileSelect={setSelectedFile} />
            </TabsContent>

            <TabsContent value="overview">
              <ArchitectureOverview repo={selectedRepo} />
            </TabsContent>

            <TabsContent value="search">
              <SymbolSearch repo={selectedRepo} onFileSelect={setSelectedFile} />
            </TabsContent>
          </Tabs>

          {/* File detail sidebar */}
          {selectedFile && (
            <FileDetail file={selectedFile} repo={selectedRepo} onClose={() => setSelectedFile(null)} />
          )}
        </>
      )}
    </div>
  );
}
