import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { ArrowRight, Clock, CheckCircle2, Circle, User, AlertCircle } from "lucide-react";
import type { HeartbeatRun } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";

// --- Pipeline definitions ---
type PipelineNode =
  | { type: "agent"; name: string; time?: string }
  | { type: "human"; label: string };

interface Pipeline {
  name: string;
  color: string;
  nodes: PipelineNode[];
}

const PIPELINES: Pipeline[] = [
  {
    name: "Reddit",
    color: "orange",
    nodes: [
      { type: "agent", name: "reddit-content-creator", time: "8 PM" },
      { type: "human", label: "Bro reviews" },
      { type: "agent", name: "reddit-writer", time: "8:30 PM" },
      { type: "human", label: "Bro posts" },
    ],
  },
  {
    name: "Reddit Comments",
    color: "orange",
    nodes: [
      { type: "agent", name: "reddit-comment-scout", time: "1 AM" },
      { type: "human", label: "Bro posts" },
    ],
  },
  {
    name: "Blog",
    color: "emerald",
    nodes: [
      { type: "agent", name: "blog-topic-proposer", time: "2 AM" },
      { type: "human", label: "Bro approves" },
      { type: "agent", name: "blog-writer-1", time: "9 PM" },
      { type: "agent", name: "blog-writer-2", time: "9:30 PM" },
      { type: "agent", name: "blog-writer-3", time: "10:30 PM" },
      { type: "human", label: "Bro reviews" },
      { type: "agent", name: "blog-publisher", time: "11 PM" },
      { type: "human", label: "Bro merges" },
    ],
  },
  {
    name: "Twitter",
    color: "sky",
    nodes: [
      { type: "agent", name: "twitter-content-creator", time: "10 PM" },
      { type: "human", label: "Bro approves" },
      { type: "agent", name: "twitter-post-approved", time: "8/10/12" },
    ],
  },
  {
    name: "Newsletter",
    color: "purple",
    nodes: [
      { type: "agent", name: "newsletter-topic-proposer", time: "Mon 2 AM" },
      { type: "human", label: "Bro approves" },
      { type: "agent", name: "newsletter-writer", time: "Mon 9 PM" },
    ],
  },
  {
    name: "Customer Support",
    color: "amber",
    nodes: [
      { type: "agent", name: "sync-customer-emails", time: "8 PM" },
      { type: "agent", name: "email-auto-drafter", time: "every 3h" },
      { type: "human", label: "Bro sends" },
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

function runRecency(lastRun: Date | null): "recent" | "stale" | "none" {
  if (!lastRun) return "none";
  const hours = (Date.now() - new Date(lastRun).getTime()) / 3600_000;
  return hours < 26 ? "recent" : "stale";
}

// --- Components ---
function AgentNode({
  name,
  time,
  agent,
  lastRun,
  runCount,
}: {
  name: string;
  time?: string;
  agent: { id: string; name: string; title: string | null } | null;
  lastRun: Date | null;
  runCount: number;
}) {
  const recency = runRecency(lastRun);

  return (
    <Link
      to={agent ? `/agents/${agent.id}` : "#"}
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 min-w-[140px] max-w-[180px] hover:bg-accent/30 transition-colors no-underline text-inherit"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 rounded-full shrink-0",
            recency === "recent" ? "bg-green-500" : recency === "stale" ? "bg-yellow-500" : "bg-zinc-600",
          )}
          title={recency === "recent" ? "Ran recently" : recency === "stale" ? "Stale (>24h)" : "No runs"}
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
        {lastRun ? (
          <span title={new Date(lastRun).toLocaleString()}>{relativeTime(lastRun)}</span>
        ) : (
          <span>no runs</span>
        )}
        {runCount > 0 ? <span className="text-muted-foreground/60">({runCount} total)</span> : null}
      </div>
    </Link>
  );
}

function HumanNode({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-2 py-2 min-w-[80px]">
      <div className="h-8 w-8 rounded-full bg-muted/50 border border-border flex items-center justify-center">
        <User className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <span className="text-[10px] text-muted-foreground text-center">{label}</span>
    </div>
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
}: {
  pipeline: Pipeline;
  agentMap: Map<string, { id: string; name: string; title: string | null }>;
  runMap: Map<string, { lastRun: Date | null; count: number }>;
}) {
  const colors = PIPELINE_COLORS[pipeline.color] ?? PIPELINE_COLORS.zinc;
  const isStandalone = pipeline.name === "Standalone";

  return (
    <div className={cn("rounded-xl border p-4", colors.border, colors.bg)}>
      <div className="flex items-center gap-2 mb-3">
        <span className={cn("h-2.5 w-2.5 rounded-full", colors.dot)} />
        <h3 className={cn("text-sm font-semibold", colors.text)}>{pipeline.name}</h3>
      </div>
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
                />
              ) : (
                <HumanNode label={node.label} />
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
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string; title: string | null }>();
    for (const a of agents ?? []) {
      map.set(a.name, { id: a.id, name: a.name, title: a.title });
    }
    return map;
  }, [agents]);

  const runMap = useMemo(() => {
    const map = new Map<string, { lastRun: Date | null; count: number }>();
    for (const r of runs ?? []) {
      const agent = agents?.find((a) => a.id === r.agentId);
      if (!agent) continue;
      const existing = map.get(agent.name);
      const runDate = r.startedAt ? new Date(r.startedAt) : null;
      if (!existing) {
        map.set(agent.name, { lastRun: runDate, count: 1 });
      } else {
        existing.count++;
        if (runDate && (!existing.lastRun || runDate > existing.lastRun)) {
          existing.lastRun = runDate;
        }
      }
    }
    return map;
  }, [runs, agents]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Content Pipelines</h1>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-green-500" /> Ran recently</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-yellow-500" /> Stale (&gt;24h)</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-zinc-600" /> No runs</span>
          <span className="flex items-center gap-1.5"><User className="h-3 w-3" /> Human step</span>
        </div>
      </div>

      {PIPELINES.map((pipeline) => (
        <PipelineRow
          key={pipeline.name}
          pipeline={pipeline}
          agentMap={agentMap}
          runMap={runMap}
        />
      ))}
    </div>
  );
}
