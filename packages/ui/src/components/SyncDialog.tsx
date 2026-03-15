import { useState } from 'react';
import { Checkbox } from './ui/checkbox';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ResponsiveDialog as Dialog, ResponsiveDialogContent as DialogContent, ResponsiveDialogHeader as DialogHeader, ResponsiveDialogTitle as DialogTitle, ResponsiveDialogDescription as DialogDescription } from './ui/responsive-dialog';

interface ConfigDiff {
  key: string;
  expected: any;
  actual: any;
}

interface AgentDrift {
  name: string;
  agentId: string;
  containerId: string;
  diffs: {
    config: ConfigDiff[];
    skills: { missing: string[]; extra: string[] };
    files: { changed: string[] };
  };
}

interface SyncResult {
  name: string;
  changes: string[];
  restarted: boolean;
  recreated: boolean;
}

interface Props {
  templateName: string;
  agents: AgentDrift[];
  onClose: () => void;
  onSync: (agents: string[], removeExtraSkills: boolean) => Promise<{ synced: SyncResult[] }>;
}

export default function SyncDialog({ templateName, agents, onClose, onSync }: Props) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(agents.map((a) => a.name)),
  );
  const [removeExtra, setRemoveExtra] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  const toggleExpand = (name: string) => {
    const next = new Set(expanded);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpanded(next);
  };

  const hasDrift = (a: AgentDrift) =>
    a.diffs.config.length > 0 ||
    a.diffs.skills.missing.length > 0 ||
    a.diffs.skills.extra.length > 0 ||
    a.diffs.files.changed.length > 0;

  const driftCount = agents.filter(hasDrift).length;

  const handleApply = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await onSync(Array.from(selected), removeExtra);
      setResult(res.synced);
    } catch (e: any) {
      setError(e.message ?? 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl sm:max-h-[80vh] sm:overflow-y-auto" showClose={false}>
        <DialogHeader>
          <DialogTitle>
            Sync &quot;{templateName}&quot; to {agents.length} agent{agents.length !== 1 ? 's' : ''}
          </DialogTitle>
          <DialogDescription>
            {driftCount > 0
              ? `${driftCount} agent${driftCount !== 1 ? 's have' : ' has'} drifted from the template.`
              : 'All agents are in sync.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Results view */}
        {result ? (
          <div className="space-y-3 mb-6">
            <h3 className="text-sm font-medium text-zinc-300">Sync Results</h3>
            {result.map((r) => (
              <div
                key={r.name}
                className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-3"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-white font-medium">{r.name}</span>
                  {r.recreated && (
                    <Badge variant="warning">recreated</Badge>
                  )}
                  {r.restarted && !r.recreated && (
                    <Badge variant="info">reloaded</Badge>
                  )}
                </div>
                <ul className="text-xs text-zinc-400 space-y-1">
                  {r.changes.map((c, i) => (
                    <li key={i}>• {c}</li>
                  ))}
                  {r.changes.length === 0 && <li>No changes needed</li>}
                </ul>
              </div>
            ))}
            <div className="flex justify-end pt-2">
              <Button variant="ghost" onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : (
          <>
            {/* Agent list */}
            <div className="space-y-2 mb-4">
              {agents.map((a) => {
                const drifted = hasDrift(a);
                const isExpanded = expanded.has(a.name);
                return (
                  <div
                    key={a.name}
                    className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-3"
                  >
                    <div className="flex items-center gap-3">
                      <Checkbox
                        checked={selected.has(a.name)}
                        onChange={() => toggle(a.name)}
                      />
                      <span className="text-white font-medium flex-1">{a.name}</span>
                      {drifted ? (
                        <Badge variant="warning">drifted</Badge>
                      ) : (
                        <Badge variant="success">in sync</Badge>
                      )}
                      {drifted && (
                        <Button
                         variant="ghost"
                          size="sm"
                          onClick={() => toggleExpand(a.name)}
                        >
                          {isExpanded ? '▼' : '▶'} details
                        </Button>
                      )}
                    </div>

                    {isExpanded && drifted && (
                      <div className="mt-3 ml-8 space-y-2 text-xs">
                        {/* Config diffs */}
                        {a.diffs.config.length > 0 && (
                          <div>
                            <p className="text-zinc-400 font-medium mb-1">Config changes:</p>
                            {a.diffs.config.map((d, i) => (
                              <div key={i} className="flex gap-2 text-zinc-500 ml-2">
                                <span className="text-zinc-300">{d.key}:</span>
                                <span className="text-red-400 line-through">
                                  {JSON.stringify(d.actual)}
                                </span>
                                <span>→</span>
                                <span className="text-green-400">
                                  {JSON.stringify(d.expected)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Skills diffs */}
                        {(a.diffs.skills.missing.length > 0 ||
                          a.diffs.skills.extra.length > 0) && (
                          <div>
                            <p className="text-zinc-400 font-medium mb-1">Skills:</p>
                            {a.diffs.skills.missing.map((s) => (
                              <div key={s} className="ml-2 text-green-400">
                                + {s}
                              </div>
                            ))}
                            {a.diffs.skills.extra.map((s) => (
                              <div key={s} className="ml-2 text-zinc-500">
                                ○ {s} (extra)
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Files diffs */}
                        {a.diffs.files.changed.length > 0 && (
                          <div>
                            <p className="text-zinc-400 font-medium mb-1">Files changed:</p>
                            {a.diffs.files.changed.map((f) => (
                              <div key={f} className="ml-2 text-amber-400">
                                ~ {f}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Options */}
            <div className="mb-6 ml-1">
              <Checkbox
                checked={removeExtra}
                onChange={setRemoveExtra}
                label="Remove extra skills not in template"
              />
            </div>

            {/* Actions */}
            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button
                variant="ghost" onClick={handleApply}
                disabled={syncing || selected.size === 0}
              >
                {syncing ? 'Syncing…' : `Apply to ${selected.size} agent${selected.size !== 1 ? 's' : ''}`}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
