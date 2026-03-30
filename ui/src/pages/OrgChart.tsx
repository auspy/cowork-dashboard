import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, relativeTime } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { Network, ArrowRight, User } from "lucide-react";
import type { Agent } from "@paperclipai/shared";

// ── Pipeline definitions ────────────────────────────────────────────
type PNode = { type: "agent"; name: string; time?: string } | { type: "human"; label: string };
interface PipelineDef { name: string; color: string; nodes: PNode[] }

const PIPELINES: PipelineDef[] = [
  { name: "Reddit", color: "#f97316", nodes: [
    { type: "agent", name: "reddit-content-creator", time: "8 PM" },
    { type: "human", label: "Bro reviews" },
    { type: "agent", name: "reddit-writer", time: "8:30 PM" },
    { type: "human", label: "Bro posts" },
  ]},
  { name: "Reddit Comments", color: "#f97316", nodes: [
    { type: "agent", name: "reddit-comment-scout", time: "1 AM" },
    { type: "human", label: "Bro posts" },
  ]},
  { name: "Blog", color: "#10b981", nodes: [
    { type: "agent", name: "blog-topic-proposer", time: "2 AM" },
    { type: "human", label: "Bro" },
    { type: "agent", name: "blog-writer-1", time: "9 PM" },
    { type: "agent", name: "blog-writer-2", time: "9:30 PM" },
    { type: "agent", name: "blog-writer-3", time: "10:30 PM" },
    { type: "human", label: "Bro" },
    { type: "agent", name: "blog-publisher", time: "11 PM" },
    { type: "human", label: "Bro merges" },
  ]},
  { name: "Twitter", color: "#0ea5e9", nodes: [
    { type: "agent", name: "twitter-content-creator", time: "10 PM" },
    { type: "human", label: "Bro" },
    { type: "agent", name: "twitter-post-approved", time: "8/10/12" },
  ]},
  { name: "Newsletter", color: "#a855f7", nodes: [
    { type: "agent", name: "newsletter-topic-proposer", time: "Mon 2 AM" },
    { type: "human", label: "Bro" },
    { type: "agent", name: "newsletter-writer", time: "Mon 9 PM" },
  ]},
  { name: "Customer Support", color: "#f59e0b", nodes: [
    { type: "agent", name: "sync-customer-emails", time: "8 PM" },
    { type: "agent", name: "email-auto-drafter", time: "every 3h" },
    { type: "human", label: "Bro sends" },
  ]},
];

const STANDALONE_AGENTS = ["daily-summary", "daily-news-digest", "competitor-watch", "git-backup",
  "content-calendar-sync", "weekly-analytics", "monthly-review", "reddit-writer-qc", "reddit-engagement-tracker"];

// ── Status colors ────────────────────────────────────────────────────
const statusDotColor: Record<string, string> = {
  running: "#22c55e", active: "#4ade80", paused: "#facc15",
  idle: "#71717a", error: "#f87171", terminated: "#a3a3a3",
};

// ── Components ──────────────────────────────────────────────────────

function AgentCard({
  agent,
  time,
  lastRun,
  onClick,
}: {
  agent: Agent | undefined;
  time?: string;
  lastRun: Date | null;
  onClick: () => void;
}) {
  const status = agent?.status ?? "idle";
  const dot = statusDotColor[status] ?? "#71717a";
  const isRunning = status === "running";

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5 min-w-[150px] max-w-[170px] hover:shadow-md hover:border-foreground/20 transition-all text-left"
      style={isRunning ? { borderColor: "#22c55e40", boxShadow: "0 0 12px rgba(34,197,94,0.15)" } : undefined}
    >
      <div className="flex items-center gap-2">
        <div className="relative shrink-0">
          <AgentIcon icon={agent?.icon} className="h-3.5 w-3.5 text-muted-foreground" />
          <span
            className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full"
            style={{ backgroundColor: dot, ...(isRunning ? { animation: "pulse 2s infinite" } : {}) }}
          />
        </div>
        <span className="text-xs font-medium truncate">{agent?.name ?? "?"}</span>
      </div>
      {time ? <span className="text-[10px] text-muted-foreground">{time}</span> : null}
      <span className="text-[10px] text-muted-foreground">
        {isRunning ? <span className="text-green-500 font-medium">Running...</span> :
          lastRun ? relativeTime(lastRun) : "no runs"}
      </span>
    </button>
  );
}

function HumanStep({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-1 self-center">
      <div className="h-7 w-7 rounded-full bg-muted/50 border border-border flex items-center justify-center">
        <User className="h-3 w-3 text-muted-foreground" />
      </div>
      <span className="text-[9px] text-muted-foreground text-center leading-tight">{label}</span>
    </div>
  );
}

function Arrow() {
  return <ArrowRight className="h-3 w-3 text-muted-foreground/40 self-center shrink-0 mx-0.5" />;
}

function PipelineSection({
  pipeline,
  agentMap,
  runMap,
  onAgentClick,
}: {
  pipeline: PipelineDef;
  agentMap: Map<string, Agent>;
  runMap: Map<string, Date | null>;
  onAgentClick: (agent: Agent) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: pipeline.color }} />
        <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: pipeline.color }}>{pipeline.name}</h3>
      </div>
      <div className="flex items-start gap-0 overflow-x-auto pb-1">
        {pipeline.nodes.map((node, i) => (
          <div key={i} className="flex items-start shrink-0">
            {i > 0 ? <Arrow /> : null}
            {node.type === "agent" ? (
              <AgentCard
                agent={agentMap.get(node.name)}
                time={node.time}
                lastRun={runMap.get(node.name) ?? null}
                onClick={() => { const a = agentMap.get(node.name); if (a) onAgentClick(a); }}
              />
            ) : (
              <HumanStep label={node.label} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  const { data: agents, isLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: runs } = useQuery({
    queryKey: [...queryKeys.heartbeats(selectedCompanyId!), "org"],
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.name, a);
    return m;
  }, [agents]);

  const runMap = useMemo(() => {
    const m = new Map<string, Date | null>();
    for (const r of runs ?? []) {
      const agent = (agents ?? []).find((a) => a.id === r.agentId);
      if (!agent) continue;
      const d = r.startedAt ? new Date(r.startedAt) : null;
      const existing = m.get(agent.name);
      if (!existing || (d && (!existing || d > existing))) m.set(agent.name, d);
    }
    return m;
  }, [runs, agents]);

  // Find agents that aren't in any pipeline
  const pipelineAgentNames = useMemo(() => {
    const names = new Set<string>();
    for (const p of PIPELINES) {
      for (const n of p.nodes) {
        if (n.type === "agent") names.add(n.name);
      }
    }
    return names;
  }, []);

  const standaloneAgents = useMemo(() => {
    return (agents ?? []).filter(
      (a) => STANDALONE_AGENTS.includes(a.name) || (!pipelineAgentNames.has(a.name) && a.status !== "terminated"),
    );
  }, [agents, pipelineAgentNames]);

  const handleClick = useCallback((agent: Agent) => {
    navigate(agentUrl(agent));
  }, [navigate]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to view the org chart." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Agent Organization</h1>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" /> Running</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-zinc-500" /> Idle</span>
          <span className="flex items-center gap-1.5"><User className="h-3 w-3" /> Human</span>
        </div>
      </div>

      {/* Pipelines */}
      <div className="space-y-4">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Content Pipelines</h2>
        <div className="grid gap-4">
          {PIPELINES.map((p) => (
            <PipelineSection
              key={p.name}
              pipeline={p}
              agentMap={agentMap}
              runMap={runMap}
              onAgentClick={handleClick}
            />
          ))}
        </div>
      </div>

      {/* Standalone */}
      {standaloneAgents.length > 0 ? (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Standalone Agents</h2>
          <div className="flex flex-wrap gap-2">
            {standaloneAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                lastRun={runMap.get(agent.name) ?? null}
                onClick={() => handleClick(agent)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
