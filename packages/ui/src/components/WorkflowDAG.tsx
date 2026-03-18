/**
 * WorkflowDAG — Pure SVG/React DAG visualisation for workflow execution.
 *
 * Renders workflow steps as a directed acyclic graph with:
 * - Nodes: rounded-rect cards with step name, agent, status indicator
 * - Edges: arrows showing waitFor dependencies (solid = completed, dashed = pending)
 * - Layout: topological sort + layer assignment (left-to-right layers)
 * - Live updates via SSE workflow.* events
 *
 * Zero external graph/viz dependencies — pure SVG + React + Tailwind.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../hooks/useApi';
import { useSSEEvent } from '../providers/SSEProvider';
import type { WorkflowStep, WorkflowStepRun } from '@coderage-labs/armada-shared';

/* ── Constants ───────────────────────────────────────── */

const NODE_WIDTH = 180;
const NODE_HEIGHT = 72;
const LAYER_GAP_X = 80;  // horizontal gap between layers
const NODE_GAP_Y = 24;   // vertical gap between nodes in same layer
const PADDING = 32;       // canvas padding

/* ── Types ───────────────────────────────────────────── */

interface ContextStep {
  id: string;
  name: string;
  role: string;
  agent: string | null;
  status: string;
  output: string | null;
  completedAt: string | null;
  iteration: number;
}

interface RunContext {
  workflow: { id: string; name: string; status: string };
  steps: ContextStep[];
  reworks: unknown[];
}

interface DAGNode {
  step: WorkflowStep;
  layer: number;
  indexInLayer: number;
  x: number;
  y: number;
  status: string;
  agentName: string | null;
}

interface DAGEdge {
  fromId: string;
  toId: string;
  isDependencyMet: boolean;
}

interface Props {
  /** Workflow definition steps */
  steps: WorkflowStep[];
  /** Current run ID — if provided, fetches live status */
  runId?: string;
  /** Pre-loaded step runs (alternative to runId) */
  stepRuns?: WorkflowStepRun[];
  /** Step selection callback */
  onSelectStep?: (stepId: string) => void;
  /** Currently selected step */
  selectedStepId?: string | null;
  /** Whether the workflow run is currently active (triggers live polling) */
  isRunning?: boolean;
}

/* ── Status helpers ──────────────────────────────────── */

const STATUS_COLORS: Record<string, { fill: string; stroke: string; text: string; dot: string }> = {
  pending:      { fill: 'rgba(63,63,70,0.4)',   stroke: '#52525b', text: '#a1a1aa', dot: '#71717a' },
  running:      { fill: 'rgba(59,130,246,0.12)', stroke: '#3b82f6', text: '#93c5fd', dot: '#3b82f6' },
  completed:    { fill: 'rgba(16,185,129,0.12)', stroke: '#10b981', text: '#6ee7b7', dot: '#10b981' },
  failed:       { fill: 'rgba(239,68,68,0.12)',  stroke: '#ef4444', text: '#fca5a5', dot: '#ef4444' },
  waiting_gate: { fill: 'rgba(245,158,11,0.12)', stroke: '#f59e0b', text: '#fcd34d', dot: '#f59e0b' },
  skipped:      { fill: 'rgba(139,92,246,0.12)', stroke: '#8b5cf6', text: '#c4b5fd', dot: '#8b5cf6' },
};

function getStatusColors(status: string) {
  return STATUS_COLORS[status] ?? STATUS_COLORS.pending;
}

/* ── Layout algorithm ────────────────────────────────── */

function computeLayers(steps: WorkflowStep[]): Map<string, number> {
  const layerMap = new Map<string, number>();
  const resolved = new Set<string>();

  function resolve(step: WorkflowStep): number {
    if (layerMap.has(step.id)) return layerMap.get(step.id)!;
    if (resolved.has(step.id)) return 0; // cycle guard
    resolved.add(step.id);

    if (!step.waitFor || step.waitFor.length === 0) {
      layerMap.set(step.id, 0);
      return 0;
    }

    let maxDep = 0;
    for (const depId of step.waitFor) {
      const dep = steps.find(s => s.id === depId);
      if (dep) {
        maxDep = Math.max(maxDep, resolve(dep) + 1);
      }
    }
    layerMap.set(step.id, maxDep);
    return maxDep;
  }

  for (const s of steps) resolve(s);
  return layerMap;
}

function buildLayout(
  steps: WorkflowStep[],
  stepStatusMap: Map<string, { status: string; agentName: string | null }>,
): { nodes: DAGNode[]; edges: DAGEdge[]; svgWidth: number; svgHeight: number } {
  if (steps.length === 0) {
    return { nodes: [], edges: [], svgWidth: 200, svgHeight: 100 };
  }

  const layerMap = computeLayers(steps);

  // Group steps by layer
  const layers: WorkflowStep[][] = [];
  for (const s of steps) {
    const layer = layerMap.get(s.id) ?? 0;
    if (!layers[layer]) layers[layer] = [];
    layers[layer].push(s);
  }

  const numLayers = layers.length;
  const maxLayerSize = Math.max(...layers.map(l => l.length));

  const svgWidth = PADDING * 2 + numLayers * NODE_WIDTH + (numLayers - 1) * LAYER_GAP_X;
  const svgHeight = PADDING * 2 + maxLayerSize * NODE_HEIGHT + (maxLayerSize - 1) * NODE_GAP_Y;

  // Build node positions
  const nodes: DAGNode[] = [];
  const nodeMap = new Map<string, DAGNode>();

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    const layerHeight = layer.length * NODE_HEIGHT + (layer.length - 1) * NODE_GAP_Y;
    const layerStartY = (svgHeight - layerHeight) / 2;

    for (let nodeIdx = 0; nodeIdx < layer.length; nodeIdx++) {
      const step = layer[nodeIdx];
      const x = PADDING + layerIdx * (NODE_WIDTH + LAYER_GAP_X);
      const y = layerStartY + nodeIdx * (NODE_HEIGHT + NODE_GAP_Y);

      const statusInfo = stepStatusMap.get(step.id) ?? { status: 'pending', agentName: null };
      const node: DAGNode = {
        step,
        layer: layerIdx,
        indexInLayer: nodeIdx,
        x,
        y,
        status: statusInfo.status,
        agentName: statusInfo.agentName,
      };
      nodes.push(node);
      nodeMap.set(step.id, node);
    }
  }

  // Build edges
  const edges: DAGEdge[] = [];
  for (const step of steps) {
    if (step.waitFor && step.waitFor.length > 0) {
      for (const depId of step.waitFor) {
        const depStatus = stepStatusMap.get(depId)?.status ?? 'pending';
        edges.push({
          fromId: depId,
          toId: step.id,
          isDependencyMet: depStatus === 'completed' || depStatus === 'skipped',
        });
      }
    }
  }

  return { nodes, edges, svgWidth, svgHeight };
}

/* ── Arrow marker definition ─────────────────────────── */
function ArrowMarkers() {
  return (
    <defs>
      <marker id="dag-arrow-solid" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#10b981" />
      </marker>
      <marker id="dag-arrow-dashed" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#52525b" />
      </marker>
      <marker id="dag-arrow-running" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#3b82f6" />
      </marker>
    </defs>
  );
}

/* ── Edge renderer ───────────────────────────────────── */
function DAGEdgeComponent({
  fromNode,
  toNode,
  isDependencyMet,
  toStatus,
}: {
  fromNode: DAGNode;
  toNode: DAGNode;
  isDependencyMet: boolean;
  toStatus: string;
}) {
  // Connect from right-center of source to left-center of target
  const x1 = fromNode.x + NODE_WIDTH;
  const y1 = fromNode.y + NODE_HEIGHT / 2;
  const x2 = toNode.x;
  const y2 = toNode.y + NODE_HEIGHT / 2;

  // Cubic bezier control points
  const dx = (x2 - x1) * 0.5;
  const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

  let stroke = '#52525b';
  let strokeDasharray = '5 4';
  let markerEnd = 'url(#dag-arrow-dashed)';
  let strokeWidth = 1.5;

  if (isDependencyMet) {
    stroke = '#10b981';
    strokeDasharray = 'none';
    markerEnd = 'url(#dag-arrow-solid)';
    strokeWidth = 1.5;
  } else if (toStatus === 'running') {
    stroke = '#3b82f6';
    strokeDasharray = 'none';
    markerEnd = 'url(#dag-arrow-running)';
    strokeWidth = 2;
  }

  return (
    <path
      d={pathD}
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeDasharray={strokeDasharray === 'none' ? undefined : strokeDasharray}
      markerEnd={markerEnd}
      opacity={0.75}
    />
  );
}

/* ── Node renderer ───────────────────────────────────── */
function DAGNodeComponent({
  node,
  isSelected,
  onClick,
}: {
  node: DAGNode;
  isSelected: boolean;
  onClick: () => void;
}) {
  const { step, x, y, status, agentName } = node;
  const colors = getStatusColors(status);
  const label = step.name ?? step.id;
  const roleLabel = step.role;
  const agentLabel = agentName ?? roleLabel;

  // Truncate long labels
  const truncate = (s: string, max: number) =>
    s.length > max ? s.slice(0, max - 1) + '…' : s;

  const isRunning = status === 'running';

  return (
    <g
      transform={`translate(${x}, ${y})`}
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      {/* Selection ring */}
      {isSelected && (
        <rect
          x={-3}
          y={-3}
          width={NODE_WIDTH + 6}
          height={NODE_HEIGHT + 6}
          rx={14}
          ry={14}
          fill="none"
          stroke="#7c3aed"
          strokeWidth={2}
          opacity={0.7}
        />
      )}

      {/* Pulse animation for running state */}
      {isRunning && (
        <rect
          x={-2}
          y={-2}
          width={NODE_WIDTH + 4}
          height={NODE_HEIGHT + 4}
          rx={13}
          ry={13}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={2}
          opacity={0.4}
        >
          <animate
            attributeName="opacity"
            values="0.4;0.8;0.4"
            dur="1.5s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="stroke-width"
            values="2;3;2"
            dur="1.5s"
            repeatCount="indefinite"
          />
        </rect>
      )}

      {/* Node body */}
      <rect
        x={0}
        y={0}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={10}
        ry={10}
        fill={colors.fill}
        stroke={colors.stroke}
        strokeWidth={isSelected ? 2 : 1.5}
      />

      {/* Status dot */}
      <circle
        cx={14}
        cy={20}
        r={4}
        fill={colors.dot}
        opacity={0.9}
      >
        {isRunning && (
          <animate
            attributeName="opacity"
            values="0.9;0.3;0.9"
            dur="1s"
            repeatCount="indefinite"
          />
        )}
      </circle>

      {/* Step name */}
      <text
        x={26}
        y={24}
        fontSize={12}
        fontWeight={600}
        fill={colors.text}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        {truncate(label, 18)}
      </text>

      {/* Agent/role label */}
      <text
        x={14}
        y={42}
        fontSize={10}
        fill="#71717a"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        {truncate(agentLabel, 22)}
      </text>

      {/* Status label */}
      <text
        x={14}
        y={58}
        fontSize={9}
        fill={colors.dot}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        opacity={0.85}
      >
        {status.replace('_', ' ')}
      </text>

      {/* Gate badge */}
      {step.gate === 'manual' && (
        <>
          <rect x={NODE_WIDTH - 42} y={4} width={38} height={14} rx={4} ry={4}
            fill="rgba(245,158,11,0.2)" stroke="#f59e0b" strokeWidth={0.8} />
          <text x={NODE_WIDTH - 23} y={14.5} fontSize={8} fill="#fcd34d"
            textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif">
            gate
          </text>
        </>
      )}
    </g>
  );
}

/* ── Main Component ──────────────────────────────────── */

export default function WorkflowDAG({
  steps,
  runId,
  stepRuns,
  onSelectStep,
  selectedStepId,
  isRunning = false,
}: Props) {
  const [contextSteps, setContextSteps] = useState<ContextStep[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Build a unified status map: stepId → { status, agentName }
  const stepStatusMap = useMemo(() => {
    const m = new Map<string, { status: string; agentName: string | null }>();

    // Priority 1: provided stepRuns (most up-to-date from parent)
    if (stepRuns && stepRuns.length > 0) {
      for (const sr of stepRuns) {
        m.set(sr.stepId, { status: sr.status, agentName: sr.agentName ?? null });
      }
      return m;
    }

    // Priority 2: context endpoint data
    for (const cs of contextSteps) {
      m.set(cs.id, { status: cs.status, agentName: cs.agent });
    }

    return m;
  }, [stepRuns, contextSteps]);

  const fetchContext = useCallback(async () => {
    if (!runId) return;
    try {
      const ctx = await apiFetch<RunContext>(`/api/workflows/runs/${runId}/context`);
      setContextSteps(ctx.steps ?? []);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message ?? 'Failed to load run context');
    }
  }, [runId]);

  // Initial fetch
  useEffect(() => {
    if (runId && !stepRuns) {
      fetchContext();
    }
  }, [runId, stepRuns, fetchContext]);

  // Poll every 5s while running (if no stepRuns provided)
  useEffect(() => {
    if (!runId || stepRuns || !isRunning) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(fetchContext, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [runId, stepRuns, isRunning, fetchContext]);

  // SSE live updates for workflow events
  const handleSSEEvent = useCallback(() => {
    if (runId && !stepRuns) {
      fetchContext();
    }
  }, [runId, stepRuns, fetchContext]);

  useSSEEvent('workflow.step.updated', handleSSEEvent);
  useSSEEvent('workflow.step.completed', handleSSEEvent);
  useSSEEvent('workflow.step.failed', handleSSEEvent);
  useSSEEvent('workflow.run.updated', handleSSEEvent);

  // Compute layout
  const { nodes, edges, svgWidth, svgHeight } = useMemo(
    () => buildLayout(steps, stepStatusMap),
    [steps, stepStatusMap],
  );

  const nodeMap = useMemo(() => {
    const m = new Map<string, DAGNode>();
    for (const n of nodes) m.set(n.step.id, n);
    return m;
  }, [nodes]);

  if (steps.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-zinc-600 text-sm">
        No steps defined in this workflow.
      </div>
    );
  }

  return (
    <div className="relative">
      {loadError && (
        <div className="mb-2 text-xs text-amber-400 opacity-70">
          ⚠ {loadError}
        </div>
      )}

      {/* Scrollable container — horizontal scroll on mobile */}
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/80">
        <svg
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          style={{ minWidth: svgWidth, display: 'block' }}
          aria-label="Workflow DAG"
        >
          <ArrowMarkers />

          {/* Edges — rendered first (behind nodes) */}
          <g className="dag-edges">
            {edges.map(edge => {
              const fromNode = nodeMap.get(edge.fromId);
              const toNode = nodeMap.get(edge.toId);
              if (!fromNode || !toNode) return null;
              return (
                <DAGEdgeComponent
                  key={`${edge.fromId}->${edge.toId}`}
                  fromNode={fromNode}
                  toNode={toNode}
                  isDependencyMet={edge.isDependencyMet}
                  toStatus={toNode.status}
                />
              );
            })}
          </g>

          {/* Nodes */}
          <g className="dag-nodes">
            {nodes.map(node => (
              <DAGNodeComponent
                key={node.step.id}
                node={node}
                isSelected={selectedStepId === node.step.id}
                onClick={() => onSelectStep?.(node.step.id)}
              />
            ))}
          </g>
        </svg>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 mt-3 px-1">
        {([
          ['pending', 'Pending'],
          ['running', 'Running'],
          ['completed', 'Completed'],
          ['failed', 'Failed'],
          ['waiting_gate', 'Waiting gate'],
          ['skipped', 'Skipped'],
        ] as [string, string][]).map(([status, label]) => {
          const c = getStatusColors(status);
          return (
            <div key={status} className="flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: c.dot }}
              />
              <span className="text-[10px] text-zinc-500">{label}</span>
            </div>
          );
        })}
        <div className="flex items-center gap-1.5">
          <svg width="24" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke="#10b981" strokeWidth="1.5" /></svg>
          <span className="text-[10px] text-zinc-500">Dep met</span>
        </div>
        <div className="flex items-center gap-1.5">
          <svg width="24" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke="#52525b" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
          <span className="text-[10px] text-zinc-500">Dep pending</span>
        </div>
      </div>
    </div>
  );
}
