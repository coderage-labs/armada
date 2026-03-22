import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import {
  GraduationCap, Trophy, Star, CheckCircle, XCircle, AlertTriangle,
  Plus, Trash2, RefreshCw, ChevronDown, ChevronRight, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';

/* ── Types ─────────────────────────────────────────── */

interface Rank {
  name: string;
  title: string;
  minScore: number;
}

interface LeaderboardAgent {
  agent: string;
  totalScore: number;
  reviewCount: number;
  avgScore: number;
  rank: Rank;
}

interface Review {
  id: string;
  runId: string;
  stepId: string;
  reviewer: string;
  executor: string;
  score: number;
  result: 'approved' | 'rejected';
  feedback: string;
  round: number;
  category: string;
  createdAt: string;
}

interface AgentScore {
  agent: string;
  rank: Rank;
  overall: {
    totalScore: number;
    reviewCount: number;
    avgScore: number;
  };
  categories: Array<{
    category: string;
    score: number;
    count: number;
    avgScore: number;
  }>;
}

interface AgentLesson {
  id: string;
  agentId: string;
  lesson: string;
  source: string;
  severity: 'high' | 'medium' | 'low';
  active: boolean;
  timesInjected: number;
  createdAt: string;
}

interface Convention {
  id: string;
  projectId: string;
  convention: string;
  source: 'manual' | 'extracted';
  evidenceCount: number;
  active: boolean;
  createdAt: string;
}

interface Project {
  id: string;
  name: string;
}

/* ── Helpers ───────────────────────────────────────── */

function relativeTime(dateStr: string): string {
  const iso = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function parseDate(dateStr: string): Date {
  const iso = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
  return new Date(iso);
}

/* ── Rank Badge ────────────────────────────────────── */

const RANK_CONFIG: Record<string, { color: string; bg: string; emoji: string }> = {
  Cadet: { color: 'text-zinc-400', bg: 'bg-zinc-600/20', emoji: '🎓' },
  Lieutenant: { color: 'text-blue-400', bg: 'bg-blue-600/20', emoji: '⭐' },
  Commander: { color: 'text-violet-400', bg: 'bg-violet-600/20', emoji: '🌟' },
  Captain: { color: 'text-amber-400', bg: 'bg-amber-500/20', emoji: '👑' },
  Admiral: { color: 'text-red-400', bg: 'bg-red-500/20', emoji: '🏆' },
};

function RankBadge({ rank, size = 'md' }: { rank: Rank; size?: 'sm' | 'md' | 'lg' }) {
  const config = RANK_CONFIG[rank.name] || RANK_CONFIG.Cadet;
  const sizeClasses = {
    sm: 'text-xs px-2 py-1',
    md: 'text-sm px-3 py-1.5',
    lg: 'text-lg px-4 py-2',
  };

  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full ${config.bg} ${config.color} font-semibold ${sizeClasses[size]}`}>
      <span>{config.emoji}</span>
      <span>{rank.name}</span>
    </div>
  );
}

/* ── Score Stars ───────────────────────────────────── */

function ScoreStars({ score }: { score: number }) {
  const color = score <= 2 ? 'text-red-400' : score === 3 ? 'text-amber-400' : 'text-emerald-400';
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <Star
          key={i}
          className={`w-3.5 h-3.5 ${i <= score ? color : 'text-zinc-700'} ${i <= score ? 'fill-current' : ''}`}
        />
      ))}
    </div>
  );
}

/* ── Leaderboard Tab ───────────────────────────────── */

function LeaderboardTab() {
  const [leaderboard, setLeaderboard] = useState<LeaderboardAgent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<LeaderboardAgent[]>('/api/learning/leaderboard')
      .then(setLeaderboard)
      .catch(err => toast.error(`Failed to load leaderboard: ${err.message}`))
      .finally(() => setLoading(false));
  }, []);

  const topThree = useMemo(() => leaderboard.slice(0, 3), [leaderboard]);
  const restOfList = useMemo(() => leaderboard.slice(3), [leaderboard]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
      </div>
    );
  }

  if (leaderboard.length === 0) {
    return (
      <div className="text-center py-12">
        <Trophy className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
        <p className="text-sm text-zinc-500">No agents reviewed yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Podium */}
      {topThree.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {topThree.map((agent, idx) => {
            const position = idx + 1;
            const heightClass = position === 1 ? 'md:order-2' : position === 2 ? 'md:order-1' : 'md:order-3';
            const badgeSize = position === 1 ? 'lg' : 'md';
            
            return (
              <div key={agent.agent} className={`${heightClass}`}>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center hover:bg-zinc-800/50 transition-all">
                  {/* Position Badge */}
                  <div className="mb-3">
                    <div className={`inline-flex items-center justify-center w-12 h-12 rounded-full ${
                      position === 1 ? 'bg-amber-500/20 text-amber-400' :
                      position === 2 ? 'bg-zinc-500/20 text-zinc-400' :
                      'bg-orange-700/20 text-orange-600'
                    } text-xl font-bold`}>
                      #{position}
                    </div>
                  </div>
                  
                  {/* Agent Name */}
                  <h3 className="text-lg font-semibold text-zinc-100 mb-2">{agent.agent}</h3>
                  
                  {/* Rank */}
                  <div className="mb-4 flex justify-center">
                    <RankBadge rank={agent.rank} size={badgeSize} />
                  </div>
                  
                  {/* Stats */}
                  <div className="space-y-2 text-sm">
                    <div>
                      <span className="text-zinc-500">Total Score: </span>
                      <span className="text-zinc-100 font-semibold">{agent.totalScore.toFixed(0)}</span>
                    </div>
                    <div>
                      <span className="text-zinc-500">Avg Score: </span>
                      <span className="text-zinc-100 font-semibold">{agent.avgScore.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-zinc-500">Reviews: </span>
                      <span className="text-zinc-100 font-semibold">{agent.reviewCount}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Full List */}
      {restOfList.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-zinc-400 mb-3">All Agents</h3>
          {restOfList.map((agent, idx) => (
            <div
              key={agent.agent}
              className="flex items-center gap-4 p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/50 transition-all"
            >
              {/* Position */}
              <div className="text-zinc-500 font-mono text-sm w-8">#{idx + 4}</div>
              
              {/* Agent Name */}
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-zinc-100 mb-1">{agent.agent}</div>
                <RankBadge rank={agent.rank} size="sm" />
              </div>
              
              {/* Score Bar */}
              <div className="flex-1 max-w-xs">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-zinc-500">Avg Score</span>
                  <span className="text-sm font-semibold text-zinc-100">{agent.avgScore.toFixed(2)}</span>
                </div>
                <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      agent.avgScore >= 4 ? 'bg-emerald-500' :
                      agent.avgScore >= 3 ? 'bg-amber-500' :
                      'bg-red-500'
                    }`}
                    style={{ width: `${(agent.avgScore / 5) * 100}%` }}
                  />
                </div>
              </div>
              
              {/* Review Count */}
              <div className="text-right">
                <div className="text-xs text-zinc-500">Reviews</div>
                <div className="text-lg font-semibold text-zinc-100">{agent.reviewCount}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Reviews Tab ───────────────────────────────────── */

function ReviewsTab() {
  const navigate = useNavigate();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterAgent, setFilterAgent] = useState<string>('all');
  const [filterResult, setFilterResult] = useState<string>('all');
  const [filterScore, setFilterScore] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Review[]>('/api/learning/reviews')
      .then(setReviews)
      .catch(err => toast.error(`Failed to load reviews: ${err.message}`))
      .finally(() => setLoading(false));
  }, []);

  const uniqueAgents = useMemo(() => {
    const agents = new Set<string>();
    reviews.forEach(r => {
      agents.add(r.executor);
      agents.add(r.reviewer);
    });
    return Array.from(agents).sort();
  }, [reviews]);

  const filteredReviews = useMemo(() => {
    return reviews.filter(r => {
      if (filterAgent !== 'all' && r.executor !== filterAgent) return false;
      if (filterResult !== 'all' && r.result !== filterResult) return false;
      if (filterScore !== 'all') {
        const score = parseInt(filterScore);
        if (r.score !== score) return false;
      }
      return true;
    });
  }, [reviews, filterAgent, filterResult, filterScore]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={filterAgent} onValueChange={setFilterAgent}>
          <SelectTrigger className="w-48 bg-zinc-900 border-zinc-700">
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {uniqueAgents.map(a => (
              <SelectItem key={a} value={a}>{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterResult} onValueChange={setFilterResult}>
          <SelectTrigger className="w-40 bg-zinc-900 border-zinc-700">
            <SelectValue placeholder="All results" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All results</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterScore} onValueChange={setFilterScore}>
          <SelectTrigger className="w-40 bg-zinc-900 border-zinc-700">
            <SelectValue placeholder="All scores" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All scores</SelectItem>
            {[1, 2, 3, 4, 5].map(s => (
              <SelectItem key={s} value={s.toString()}>{s} stars</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {(filterAgent !== 'all' || filterResult !== 'all' || filterScore !== 'all') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFilterAgent('all');
              setFilterResult('all');
              setFilterScore('all');
            }}
            className="text-zinc-500 hover:text-zinc-300"
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Reviews List */}
      {filteredReviews.length === 0 ? (
        <div className="text-center py-12">
          <CheckCircle className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">No reviews found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredReviews.map(review => {
            const expanded = expandedId === review.id;
            return (
              <div
                key={review.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden"
              >
                <div
                  className="p-4 flex items-center gap-4 cursor-pointer hover:bg-zinc-800/50 transition-all"
                  onClick={() => setExpandedId(expanded ? null : review.id)}
                >
                  {/* Expand icon */}
                  <div className="shrink-0">
                    {expanded ? (
                      <ChevronDown className="w-4 h-4 text-zinc-500" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-zinc-500" />
                    )}
                  </div>

                  {/* Date */}
                  <div className="text-xs text-zinc-500 w-20 shrink-0">
                    {relativeTime(review.createdAt)}
                  </div>

                  {/* Workflow run link */}
                  <div
                    className="text-sm text-violet-400 hover:text-violet-300 font-mono shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/workflows/${review.runId}`);
                    }}
                  >
                    Run #{review.runId.slice(0, 8)}
                  </div>

                  {/* Executor */}
                  <div className="text-sm text-zinc-300 font-medium min-w-0 truncate">
                    {review.executor}
                  </div>

                  {/* Reviewer */}
                  <div className="text-xs text-zinc-500">
                    by {review.reviewer}
                  </div>

                  {/* Score */}
                  <div className="shrink-0">
                    <ScoreStars score={review.score} />
                  </div>

                  {/* Result */}
                  <div className="shrink-0">
                    {review.result === 'approved' ? (
                      <CheckCircle className="w-5 h-5 text-emerald-400" />
                    ) : (
                      <XCircle className="w-5 h-5 text-red-400" />
                    )}
                  </div>

                  {/* Category */}
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {review.category}
                  </Badge>
                </div>

                {/* Expanded content */}
                {expanded && (
                  <div className="px-4 pb-4 border-t border-zinc-800/50 mt-2 pt-4 space-y-3">
                    <div>
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                        Feedback
                      </div>
                      <div className="text-sm text-zinc-300 whitespace-pre-wrap bg-zinc-950/50 p-3 rounded border border-zinc-800">
                        {review.feedback || 'No feedback provided'}
                      </div>
                    </div>
                    <div className="flex gap-4 text-xs text-zinc-500">
                      <span>Round: {review.round}</span>
                      <span>Step: {review.stepId.slice(0, 8)}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Conventions Tab ───────────────────────────────── */

function ConventionsTab() {
  const [conventions, setConventions] = useState<Convention[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newConvention, setNewConvention] = useState('');

  useEffect(() => {
    apiFetch<Project[]>('/api/projects')
      .then(setProjects)
      .catch(err => toast.error(`Failed to load projects: ${err.message}`));
  }, []);

  useEffect(() => {
    if (!selectedProject) {
      setConventions([]);
      return;
    }
    setLoading(true);
    apiFetch<Convention[]>('/api/learning/conventions', {
      method: 'POST',
      body: JSON.stringify({ projectId: selectedProject }),
    })
      .then(setConventions)
      .catch(err => toast.error(`Failed to load conventions: ${err.message}`))
      .finally(() => setLoading(false));
  }, [selectedProject]);

  const handleAddConvention = async () => {
    if (!selectedProject || !newConvention.trim()) {
      toast.error('Please select a project and enter a convention');
      return;
    }

    try {
      const added = await apiFetch<Convention>('/api/learning/conventions/add', {
        method: 'POST',
        body: JSON.stringify({ projectId: selectedProject, convention: newConvention }),
      });
      setConventions([...conventions, added]);
      setNewConvention('');
      setShowAddForm(false);
      toast.success('Convention added');
    } catch (err: any) {
      toast.error(`Failed to add convention: ${err.message}`);
    }
  };

  const handleExtract = async () => {
    if (!selectedProject) {
      toast.error('Please select a project');
      return;
    }

    setExtracting(true);
    try {
      const result = await apiFetch<{
        newConventions: number;
        updatedConventions: number;
        totalReviewsAnalysed: number;
      }>('/api/learning/conventions/extract', {
        method: 'POST',
        body: JSON.stringify({ projectId: selectedProject }),
      });
      
      toast.success(
        `Extracted conventions: ${result.newConventions} new, ${result.updatedConventions} updated (${result.totalReviewsAnalysed} reviews analysed)`
      );
      
      // Reload conventions
      const updated = await apiFetch<Convention[]>('/api/learning/conventions', {
        method: 'POST',
        body: JSON.stringify({ projectId: selectedProject }),
      });
      setConventions(updated);
    } catch (err: any) {
      toast.error(`Failed to extract conventions: ${err.message}`);
    } finally {
      setExtracting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this convention?')) return;

    try {
      await apiFetch(`/api/learning/conventions/${id}`, { method: 'DELETE' });
      setConventions(conventions.filter(c => c.id !== id));
      toast.success('Convention deleted');
    } catch (err: any) {
      toast.error(`Failed to delete: ${err.message}`);
    }
  };

  const handleToggle = async (id: string, active: boolean) => {
    try {
      await apiFetch(`/api/learning/conventions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active }),
      });
      setConventions(conventions.map(c => c.id === id ? { ...c, active } : c));
      toast.success(`Convention ${active ? 'enabled' : 'disabled'}`);
    } catch (err: any) {
      toast.error(`Failed to update: ${err.message}`);
    }
  };

  return (
    <div className="space-y-4">
      {/* Project selector + actions */}
      <div className="flex flex-wrap gap-3 items-center">
        <Select value={selectedProject} onValueChange={setSelectedProject}>
          <SelectTrigger className="w-64 bg-zinc-900 border-zinc-700">
            <SelectValue placeholder="Select project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map(p => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selectedProject && (
          <>
            <Button
              onClick={() => setShowAddForm(!showAddForm)}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Convention
            </Button>

            <Button
              onClick={handleExtract}
              disabled={extracting}
              variant="outline"
              className="border-zinc-700 hover:bg-zinc-800"
            >
              {extracting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              Extract Conventions
            </Button>
          </>
        )}
      </div>

      {/* Add form */}
      {showAddForm && selectedProject && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
          <Textarea
            placeholder="Enter convention..."
            value={newConvention}
            onChange={(e) => setNewConvention(e.target.value)}
            className="bg-zinc-950 border-zinc-700"
            rows={3}
          />
          <div className="flex gap-2">
            <Button onClick={handleAddConvention} className="bg-violet-600 hover:bg-violet-700">
              Add
            </Button>
            <Button
              onClick={() => {
                setShowAddForm(false);
                setNewConvention('');
              }}
              variant="ghost"
              className="text-zinc-500"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Conventions list */}
      {!selectedProject ? (
        <div className="text-center py-12">
          <GraduationCap className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">Select a project to view conventions</p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
        </div>
      ) : conventions.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm text-zinc-500">No conventions yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {conventions.map(conv => (
            <div
              key={conv.id}
              className="flex items-start gap-4 p-4 rounded-lg border border-zinc-800 bg-zinc-900/50"
            >
              <div className="flex-1 min-w-0 space-y-2">
                <div className="text-sm text-zinc-300">{conv.convention}</div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={conv.source === 'manual' ? 'default' : 'outline'}
                    className="text-xs"
                  >
                    {conv.source}
                  </Badge>
                  <span className="text-xs text-zinc-500">
                    Evidence: {conv.evidenceCount}
                  </span>
                  <span className="text-xs text-zinc-600">
                    {relativeTime(conv.createdAt)}
                  </span>
                </div>
              </div>
              
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggle(conv.id, !conv.active)}
                  className={conv.active ? 'text-emerald-400' : 'text-zinc-600'}
                >
                  {conv.active ? 'Active' : 'Inactive'}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(conv.id)}
                  className="text-red-400 hover:text-red-300"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Agent Lessons Tab ─────────────────────────────── */

function AgentLessonsTab() {
  const [lessons, setLessons] = useState<AgentLesson[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Get unique agents from reviews
  const [agents, setAgents] = useState<string[]>([]);
  useEffect(() => {
    apiFetch<Review[]>('/api/learning/reviews')
      .then(reviews => {
        const uniqueAgents = new Set<string>();
        reviews.forEach(r => uniqueAgents.add(r.executor));
        setAgents(Array.from(uniqueAgents).sort());
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedAgent) {
      setLessons([]);
      return;
    }
    setLoading(true);
    apiFetch<AgentLesson[]>('/api/learning/agent-lessons', {
      method: 'POST',
      body: JSON.stringify({ agent: selectedAgent }),
    })
      .then(setLessons)
      .catch(err => toast.error(`Failed to load lessons: ${err.message}`))
      .finally(() => setLoading(false));
  }, [selectedAgent]);

  const handleToggle = async (id: string, active: boolean) => {
    try {
      await apiFetch(`/api/learning/agent-lessons/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active }),
      });
      setLessons(lessons.map(l => l.id === id ? { ...l, active } : l));
      toast.success(`Lesson ${active ? 'enabled' : 'disabled'}`);
    } catch (err: any) {
      toast.error(`Failed to update: ${err.message}`);
    }
  };

  return (
    <div className="space-y-4">
      {/* Agent selector */}
      <Select value={selectedAgent} onValueChange={setSelectedAgent}>
        <SelectTrigger className="w-64 bg-zinc-900 border-zinc-700">
          <SelectValue placeholder="Select agent" />
        </SelectTrigger>
        <SelectContent>
          {agents.map(a => (
            <SelectItem key={a} value={a}>{a}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Lessons list */}
      {!selectedAgent ? (
        <div className="text-center py-12">
          <GraduationCap className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">Select an agent to view lessons</p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
        </div>
      ) : lessons.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm text-zinc-500">No lessons recorded yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {lessons.map(lesson => (
            <div
              key={lesson.id}
              className="flex items-start gap-4 p-4 rounded-lg border border-zinc-800 bg-zinc-900/50"
            >
              {/* Severity badge */}
              <div className="shrink-0 text-lg">
                {lesson.severity === 'high' ? '🔴' : '⚠️'}
              </div>
              
              <div className="flex-1 min-w-0 space-y-2">
                <div className="text-sm text-zinc-300">{lesson.lesson}</div>
                <div className="flex items-center gap-3 text-xs text-zinc-500">
                  <span>Source: {lesson.source.slice(0, 12)}...</span>
                  <span>Injected {lesson.timesInjected} times</span>
                  <span>{relativeTime(lesson.createdAt)}</span>
                </div>
              </div>
              
              <div className="shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggle(lesson.id, !lesson.active)}
                  className={lesson.active ? 'text-emerald-400' : 'text-zinc-600'}
                >
                  {lesson.active ? 'Active' : 'Inactive'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main Component ────────────────────────────────── */

export default function Learning() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={GraduationCap}
        title="Learning"
        subtitle="Agent leaderboard, conventions, and review history"
      />

      <Tabs defaultValue="leaderboard" className="space-y-4">
        <TabsList className="bg-zinc-900 border border-zinc-800">
          <TabsTrigger value="leaderboard">
            <Trophy className="w-4 h-4 mr-2" />
            Leaderboard
          </TabsTrigger>
          <TabsTrigger value="reviews">
            <Star className="w-4 h-4 mr-2" />
            Reviews
          </TabsTrigger>
          <TabsTrigger value="conventions">
            <GraduationCap className="w-4 h-4 mr-2" />
            Conventions
          </TabsTrigger>
          <TabsTrigger value="lessons">
            <AlertTriangle className="w-4 h-4 mr-2" />
            Agent Lessons
          </TabsTrigger>
        </TabsList>

        <TabsContent value="leaderboard">
          <LeaderboardTab />
        </TabsContent>

        <TabsContent value="reviews">
          <ReviewsTab />
        </TabsContent>

        <TabsContent value="conventions">
          <ConventionsTab />
        </TabsContent>

        <TabsContent value="lessons">
          <AgentLessonsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
