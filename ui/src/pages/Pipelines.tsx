import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { ArrowRight, Clock, User, AlertCircle } from "lucide-react";
import type { HeartbeatRun, Issue } from "@paperclipai/shared";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";

// --- Pipeline definitions ---
type PipelineNode =
  | { type: "agent"; name: string; time?: string; statusFilter?: string[]; pipelineStatusFilter?: string[] }
  | { type: "human"; label: string; statusFilter?: string[]; pipelineStatusFilter?: string[] };

interface Pipeline {
  name: string;
  color: string;
  channel?: string;
  nodes: PipelineNode[];
}

const PIPELINES: Pipeline[] = [
  {
    name: "Reddit",
    color: "orange",
    channel: "reddit",
    nodes: [
      { type: "agent", name: "reddit-content-creator", time: "8 PM", pipelineStatusFilter: ["topic-proposed"] },
      { type: "human", label: "Review", pipelineStatusFilter: ["drafted"] },
      { type: "agent", name: "reddit-writer", time: "8:30 PM", pipelineStatusFilter: ["ready_to_post"] },
      { type: "human", label: "Post", statusFilter: ["todo"] },
    ],
  },
  {
    name: "Reddit Comments",
    color: "orange",
    channel: "reddit-comments",
    nodes: [
      { type: "agent", name: "reddit-comment-scout", time: "1 AM", pipelineStatusFilter: ["draft"] },
      { type: "human", label: "Post", statusFilter: ["backlog", "todo", "in_review"] },
    ],
  },
  {
    name: "Blog",
    color: "emerald",
    channel: "blog",
    nodes: [
      { type: "agent", name: "blog-topic-proposer", time: "2 AM", pipelineStatusFilter: ["topic-proposed"] },
      { type: "human", label: "Approve", statusFilter: ["backlog"], pipelineStatusFilter: ["topic-proposed"] },
      { type: "agent", name: "blog-writer-1", time: "9 PM", pipelineStatusFilter: ["topic-approved"] },
      { type: "agent", name: "blog-writer-2", time: "9:30 PM" },
      { type: "agent", name: "blog-writer-3", time: "10:30 PM" },
      { type: "human", label: "Review", pipelineStatusFilter: ["pr-created"] },
      { type: "agent", name: "blog-publisher", time: "11 PM" },
      { type: "human", label: "Merge", statusFilter: ["todo"] },
    ],
  },
  {
    name: "Twitter",
    color: "sky",
    channel: "twitter",
    nodes: [
      { type: "agent", name: "twitter-content-creator", time: "10 PM", pipelineStatusFilter: ["topic-proposed"] },
      { type: "human", label: "Approve", pipelineStatusFilter: ["drafted"] },
      { type: "agent", name: "twitter-post-approved", time: "8/10/12", pipelineStatusFilter: ["ready_to_post"] },
    ],
  },
  {
    name: "Newsletter",
    color: "purple",
    channel: "newsletter",
    nodes: [
      { type: "agent", name: "newsletter-topic-proposer", time: "Mon 2 AM", pipelineStatusFilter: ["topic-proposed"] },
      { type: "human", label: "Approve", statusFilter: ["in_review", "needs_revision"] },
      { type: "agent", name: "newsletter-writer", time: "Mon 9 PM", pipelineStatusFilter: ["topic-approved"] },
    ],
  },
  {
    name: "Customer Support",
    color: "amber",
    nodes: [
      { type: "agent", name: "sync-customer-emails", time: "8 PM" },
      { type: "agent", name: "email-auto-drafter", time: "every 3h" },
      { type: "human", label: "Send" },
    ],
  },
  {
    name: "Standalone",
    color: "zinc",
    nodes: [
      { type: "agent", name: "daily-summary", time: "9 PM" },
      { type: "agent", name: "daily-news-digest", time: "9 AM" },
      { type: "agent", name: "competitor-watch", time: "Mon 8 PM" },
      { type: "agent", name: "git-backup", time: "9:30/5:30" },
    ],
  },
];

// --- Color maps ---
const PIPELINE_COLORS: Record<string, { border: string; bg: string; text: string; dot: string }> = {
  orange:  { border: "border-orange-500/30", bg: "bg-orange-500/10", text: "text-orange-400", dot: "bg-orange-500" },
  emerald: { border: "border-emerald-500/30", bg: "bg-emerald-500/10", text: "text-emerald-400", dot: "bg-emerald-500" },
  sky:     { border: "border-sky-500/30", bg: "bg-sky-500/10", text: "text-sky-400", dot: "bg-sky-500" },
  purple:  { border: "border-purple-500/30", bg: "bg-purple-500/10", text: "text-purple-400", dot: "bg-purple-500" },
  amber:   { border: "border-amber-500/30", bg: "bg-amber-500/10", text: "text-amber-400", dot: "bg-amber-500" },
  zinc:    { border: "border-zinc-500/30", bg: "bg-zinc-500/10", text: "text-zinc-400", dot: "bg-zinc-500" },
};

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

function runRecency(lastRun: Date | null, isRunning: boolean): "running" | "recent" | "stale" | "none" {
  if (isRunning) return "running";
  if (!lastRun) return "none";
  const hours = (Date.now() - new Date(lastRun).getTime()) / 3600_000;
  return hours < 26 ? "recent" : "stale";
}

// --- Pipeline counts ---
interface PipelineCounts {
  byNodeIndex: Map<number, Issue[]>;
  /** Most common projectId among this pipeline's issues (for linking) */
  projectId: string | null;
  totalActive: number;
  totalDone: number;
}

function computePipelineCounts(issues: Issue[]): Map<string, PipelineCounts> {
  const map = new Map<string, PipelineCounts>();

  // Group issues by channel
  const byChannel = new Map<string, Issue[]>();
  for (const issue of issues) {
    const channel = (issue.metadata as Record<string, unknown> | null)?.channel;
    if (typeof channel === "string") {
      const arr = byChannel.get(channel) ?? [];
      arr.push(issue);
      byChannel.set(channel, arr);
    }
  }

  for (const pipeline of PIPELINES) {
    if (!pipeline.channel) continue;
    const channelIssues = byChannel.get(pipeline.channel) ?? [];
    const byNodeIndex = new Map<number, Issue[]>();
    let totalActive = 0;
    let totalDone = 0;

    for (const issue of channelIssues) {
      if (issue.status === "done") totalDone++;
      if (!TERMINAL_STATUSES.has(issue.status)) totalActive++;
    }

    // Derive the most common projectId for linking
    const projectCounts = new Map<string, number>();
    for (const issue of channelIssues) {
      if (issue.projectId) {
        projectCounts.set(issue.projectId, (projectCounts.get(issue.projectId) ?? 0) + 1);
      }
    }
    let projectId: string | null = null;
    let maxCount = 0;
    for (const [pid, c] of projectCounts) {
      if (c > maxCount) { maxCount = c; projectId = pid; }
    }

    pipeline.nodes.forEach((node, i) => {
      if (!node.statusFilter && !node.pipelineStatusFilter) return;
      const matching = channelIssues.filter((issue) => {
        const ps = String((issue.metadata as Record<string, unknown> | null)?.pipeline_status ?? "");
        if (node.statusFilter?.includes(issue.status)) return true;
        if (node.pipelineStatusFilter?.includes(ps)) return true;
        return false;
      });
      byNodeIndex.set(i, matching);
    });

    map.set(pipeline.name, { byNodeIndex, projectId, totalActive, totalDone });
  }

  return map;
}

// --- Components ---
function AgentNode({
  name,
  time,
  agent,
  lastRun,
  runCount,
  isRunning,
  stageIssues,
}: {
  name: string;
  time?: string;
  agent: { id: string; name: string; title: string | null } | null;
  lastRun: Date | null;
  runCount: number;
  isRunning: boolean;
  stageIssues: Issue[];
}) {
  const recency = runRecency(lastRun, isRunning);
  const issueCount = stageIssues.length;

  const card = (
    <Link
      to={agent ? `/agents/${agent.id}` : "#"}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 min-w-[140px] max-w-[180px] hover:bg-accent/30 transition-colors no-underline text-inherit",
        issueCount > 0 ? "border-blue-500/30 bg-blue-500/5" : "border-border bg-card",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 rounded-full shrink-0",
            recency === "running" ? "bg-green-500 animate-pulse" :
            recency === "recent" ? "bg-blue-500" :
            recency === "stale" ? "bg-yellow-500" : "bg-zinc-600",
          )}
          title={recency === "running" ? "Running now" : recency === "recent" ? "Ran recently" : recency === "stale" ? "Stale (>24h)" : "No runs"}
        />
        <span className="text-xs font-medium truncate">{name}</span>
      </div>
      {time ? (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock className="h-2.5 w-2.5" />
          {time}
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        {isRunning ? (
          <span className="text-green-500 font-medium">Running...</span>
        ) : lastRun ? (
          <span title={new Date(lastRun).toLocaleString()}>{relativeTime(lastRun)}</span>
        ) : (
          <span>no runs</span>
        )}
        {runCount > 0 ? <span className="text-muted-foreground/60">({runCount} runs)</span> : null}
      </div>
      {issueCount > 0 && (
        <div className="flex items-center gap-1 text-[10px] font-medium text-blue-400">
          {issueCount} task{issueCount !== 1 ? "s" : ""}
        </div>
      )}
    </Link>
  );

  if (issueCount === 0) return card;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{card}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[240px]">
        <p className="font-medium mb-1">{issueCount} active issue{issueCount !== 1 ? "s" : ""}</p>
        {stageIssues.slice(0, 4).map((issue) => (
          <p key={issue.id} className="truncate text-xs text-muted-foreground">
            {issue.identifier ?? issue.id.slice(0, 8)}: {issue.title}
          </p>
        ))}
        {issueCount > 4 && (
          <p className="text-xs text-muted-foreground">+{issueCount - 4} more</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function HumanNode({
  label,
  waitingIssues,
  projectId,
}: {
  label: string;
  waitingIssues: Issue[];
  projectId: string | null;
}) {
  const count = waitingIssues.length;
  const hasWork = count > 0;

  // Link to the first issue if exactly one, project issues if we know the project, otherwise global issues
  const linkTarget = count === 1
    ? `/issues/${waitingIssues[0].identifier ?? waitingIssues[0].id}`
    : projectId
      ? `/projects/${projectId}/issues`
      : "/issues";

  const inner = (
    <div className="relative">
      <div
        className={cn(
          "h-8 w-8 rounded-full border flex items-center justify-center",
          hasWork ? "bg-amber-500/20 border-amber-500/50" : "bg-muted/50 border-border",
        )}
      >
        <User className={cn("h-3.5 w-3.5", hasWork ? "text-amber-400" : "text-muted-foreground")} />
      </div>
      {count > 0 && (
        <span className="absolute -top-1.5 -right-2 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
          {count}
        </span>
      )}
    </div>
  );

  const node = hasWork ? (
    <Link
      to={linkTarget}
      className={cn(
        "flex flex-col items-center gap-1.5 px-3 py-2.5 min-w-[90px] rounded-lg border transition-colors no-underline text-inherit",
        "border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20",
      )}
    >
      {inner}
      <span className="text-[10px] text-center font-medium text-amber-300">{label}</span>
    </Link>
  ) : (
    <div
      className="flex flex-col items-center gap-1.5 px-3 py-2.5 min-w-[90px] rounded-lg border border-border bg-card/50 transition-colors"
    >
      {inner}
      <span className="text-[10px] text-center font-medium text-muted-foreground">{label}</span>
    </div>
  );

  if (count === 0) return node;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{node}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[240px]">
        <p className="font-medium mb-1">
          {count} issue{count !== 1 ? "s" : ""} waiting
        </p>
        {waitingIssues.slice(0, 4).map((issue) => (
          <p key={issue.id} className="truncate text-xs text-muted-foreground">
            {issue.identifier ?? issue.id.slice(0, 8)}: {issue.title}
          </p>
        ))}
        {count > 4 && (
          <p className="text-xs text-muted-foreground">+{count - 4} more</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function Arrow() {
  return (
    <div className="flex items-center px-1 text-muted-foreground/40 shrink-0 self-center">
      <ArrowRight className="h-3.5 w-3.5" />
    </div>
  );
}

function PipelineRow({
  pipeline,
  agentMap,
  runMap,
  pipelineCounts,
}: {
  pipeline: Pipeline;
  agentMap: Map<string, { id: string; name: string; title: string | null }>;
  runMap: Map<string, { lastRun: Date | null; count: number; isRunning: boolean }>;
  pipelineCounts: PipelineCounts | null;
}) {
  const colors = PIPELINE_COLORS[pipeline.color] ?? PIPELINE_COLORS.zinc;
  const isStandalone = pipeline.name === "Standalone";

  // Count total waiting across all human nodes in this pipeline
  const totalWaiting = pipelineCounts
    ? Array.from(pipelineCounts.byNodeIndex.values()).reduce((sum, arr) => sum + arr.length, 0)
    : 0;

  return (
    <div className={cn("rounded-xl border p-4", colors.border, colors.bg)}>
      <div className="flex items-center gap-2 mb-1">
        <span className={cn("h-2.5 w-2.5 rounded-full", colors.dot)} />
        {pipelineCounts?.projectId ? (
          <Link to={`/projects/${pipelineCounts.projectId}/issues`} className={cn("text-sm font-semibold no-underline hover:underline", colors.text)}>
            {pipeline.name}
          </Link>
        ) : (
          <h3 className={cn("text-sm font-semibold", colors.text)}>{pipeline.name}</h3>
        )}
        {totalWaiting > 0 && (
          <span className="flex items-center gap-1 ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-400">
            <AlertCircle className="h-2.5 w-2.5" />
            {totalWaiting} waiting
          </span>
        )}
      </div>

      {pipelineCounts && (
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground mb-3">
          <span>{pipelineCounts.totalActive} active</span>
          <span className="text-muted-foreground/40">·</span>
          <span>{pipelineCounts.totalDone} done</span>
          {(pipelineCounts.totalActive + pipelineCounts.totalDone) > 0 && (
            <div className="w-16 h-1 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full", colors.dot)}
                style={{
                  width: `${(pipelineCounts.totalDone / (pipelineCounts.totalDone + pipelineCounts.totalActive)) * 100}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      <div className={cn("flex items-start gap-0", isStandalone ? "flex-wrap gap-2" : "overflow-x-auto pb-2")}>
        {pipeline.nodes.map((node, i) => {
          const showArrow = !isStandalone && i > 0;
          return (
            <div key={i} className="flex items-start shrink-0">
              {showArrow ? <Arrow /> : null}
              {node.type === "agent" ? (
                <AgentNode
                  name={node.name}
                  time={node.time}
                  agent={agentMap.get(node.name) ?? null}
                  lastRun={runMap.get(node.name)?.lastRun ?? null}
                  runCount={runMap.get(node.name)?.count ?? 0}
                  isRunning={runMap.get(node.name)?.isRunning ?? false}
                  stageIssues={pipelineCounts?.byNodeIndex.get(i) ?? []}
                />
              ) : (
                <HumanNode
                  label={node.label}
                  waitingIssues={pipelineCounts?.byNodeIndex.get(i) ?? []}
                  projectId={pipelineCounts?.projectId ?? null}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Page ---
export function Pipelines() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Pipelines" }]);
  }, [setBreadcrumbs]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: runs } = useQuery({
    queryKey: [...queryKeys.heartbeats(selectedCompanyId!), "pipeline"],
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string; title: string | null }>();
    for (const a of agents ?? []) {
      map.set(a.name, { id: a.id, name: a.name, title: a.title });
    }
    return map;
  }, [agents]);

  const runMap = useMemo(() => {
    const map = new Map<string, { lastRun: Date | null; count: number; isRunning: boolean }>();
    for (const r of runs ?? []) {
      const agent = agents?.find((a) => a.id === r.agentId);
      if (!agent) continue;
      const existing = map.get(agent.name);
      const runDate = r.startedAt ? new Date(r.startedAt) : null;
      const running = r.status === "running";
      if (!existing) {
        map.set(agent.name, { lastRun: runDate, count: 1, isRunning: running });
      } else {
        existing.count++;
        if (running) existing.isRunning = true;
        if (runDate && (!existing.lastRun || runDate > existing.lastRun)) {
          existing.lastRun = runDate;
        }
      }
    }
    return map;
  }, [runs, agents]);

  const pipelineCountsMap = useMemo(
    () => computePipelineCounts(issues ?? []),
    [issues],
  );

  // Global summary: total items waiting across all pipelines
  const totalWaiting = useMemo(() => {
    let total = 0;
    for (const [, counts] of pipelineCountsMap) {
      for (const [, nodeIssues] of counts.byNodeIndex) {
        total += nodeIssues.length;
      }
    }
    return total;
  }, [pipelineCountsMap]);

  // Per-pipeline waiting counts for the summary chips
  const pipelineWaitingSummary = useMemo(() => {
    const result: { name: string; color: string; count: number }[] = [];
    for (const pipeline of PIPELINES) {
      const counts = pipelineCountsMap.get(pipeline.name);
      if (!counts) continue;
      let waiting = 0;
      for (const [, nodeIssues] of counts.byNodeIndex) {
        waiting += nodeIssues.length;
      }
      if (waiting > 0) {
        result.push({ name: pipeline.name, color: pipeline.color, count: waiting });
      }
    }
    return result;
  }, [pipelineCountsMap]);

  return (
    <div className="space-y-6">
      {/* Header + Summary */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Content Pipelines</h1>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" /> Running</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-blue-500" /> Recent</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-yellow-500" /> Stale</span>
            <span className="flex items-center gap-1.5"><User className="h-3 w-3" /> Human step</span>
          </div>
        </div>

        {/* Attention summary */}
        {totalWaiting > 0 && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-medium text-amber-300">
                {totalWaiting} item{totalWaiting !== 1 ? "s" : ""} need your attention
              </span>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              {pipelineWaitingSummary.map((p) => {
                const colors = PIPELINE_COLORS[p.color] ?? PIPELINE_COLORS.zinc;
                return (
                  <span
                    key={p.name}
                    className={cn("flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium", colors.bg, colors.text)}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", colors.dot)} />
                    {p.name} ({p.count})
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Pipeline rows */}
      {PIPELINES.map((pipeline) => (
        <PipelineRow
          key={pipeline.name}
          pipeline={pipeline}
          agentMap={agentMap}
          runMap={runMap}
          pipelineCounts={pipelineCountsMap.get(pipeline.name) ?? null}
        />
      ))}
    </div>
  );
}
