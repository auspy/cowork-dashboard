import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { ChevronRight, ExternalLink } from "lucide-react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { cn } from "../lib/utils";
import type { Issue } from "@paperclipai/shared";

const CHANNEL_COLORS: Record<string, string> = {
  reddit: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  twitter: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  blog: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  newsletter: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
};

const URL_META_KEYS = ["url", "source_url", "reddit_url", "post_url", "thread_url", "link", "reddit_link", "reddit_post_url"];

function getExternalUrl(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  // Check well-known key names first
  for (const key of URL_META_KEYS) {
    const val = metadata[key];
    if (typeof val === "string" && val.startsWith("http")) return val;
  }
  // Fallback: scan all string values for a reddit.com URL
  for (const val of Object.values(metadata)) {
    if (typeof val === "string" && /https?:\/\/(www\.)?reddit\.com\//.test(val)) return val;
  }
  return null;
}

function getContentPreview(metadata: Record<string, unknown> | null | undefined): { title: string | null; body: string | null } {
  if (!metadata) return { title: null, body: null };
  const rawTitle = metadata.draft_title ?? metadata.suggested_title ?? metadata.subject_line;
  const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : null;
  const rawBody = metadata.draft_body ?? metadata.content ?? metadata.posted_text;
  const body = typeof rawBody === "string" && rawBody.trim() ? rawBody.trim() : null;
  return { title, body };
}

const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "needs_revision",
  "blocked",
  "done",
  "cancelled",
];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  issues,
  agents,
  liveIssueIds,
  collapsed,
  onToggleCollapse,
}: {
  status: string;
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        className={`flex flex-col items-center shrink-0 w-9 rounded-md cursor-pointer select-none transition-colors ${
          isOver ? "bg-accent/40" : "bg-muted/20"
        }`}
        onClick={onToggleCollapse}
        title={`Expand ${statusLabel(status)}`}
      >
        <div className="flex flex-col items-center gap-2 py-3">
          <StatusIcon status={status} />
          <span className="text-[10px] font-semibold text-muted-foreground/60 tabular-nums">
            {issues.length}
          </span>
        </div>
        <span
          className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
          style={{ writingMode: "vertical-lr" }}
        >
          {statusLabel(status)}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-w-[260px] w-[260px] shrink-0">
      <div
        className="flex items-center gap-2 px-2 py-2 mb-1 cursor-pointer select-none rounded hover:bg-accent/30 transition-colors"
        onClick={onToggleCollapse}
        title={`Collapse ${statusLabel(status)}`}
      >
        <StatusIcon status={status} />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {statusLabel(status)}
        </span>
        <span className="text-xs text-muted-foreground/60 ml-auto tabular-nums">
          {issues.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[120px] rounded-md p-1 space-y-1 transition-colors ${
          isOver ? "bg-accent/40" : "bg-muted/20"
        }`}
      >
        <SortableContext
          items={issues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {issues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              isLive={liveIssueIds?.has(issue.id)}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

/* ── Description Dropdown ── */

function DescriptionDropdown({ description, defaultOpen }: { description: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        Angle
      </button>
      {open && (
        <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap mt-1">
          {description}
        </p>
      )}
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  isLive,
  isOverlay,
}: {
  issue: Issue;
  agents?: Agent[];
  isLive?: boolean;
  isOverlay?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`rounded-md border bg-card p-2.5 cursor-grab active:cursor-grabbing transition-shadow ${
        isDragging && !isOverlay ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"}`}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        className="block no-underline text-inherit"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        <div className="flex items-start gap-1.5 mb-1.5">
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {isLive && (
            <span className="relative flex h-2 w-2 shrink-0 mt-0.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          )}
        </div>
        <p className="text-sm leading-snug line-clamp-2 mb-1.5">{issue.title}</p>
        {(() => {
          const meta = issue.metadata as Record<string, unknown> | null | undefined;
          const channel = meta?.channel ? String(meta.channel) : null;
          const contentType = meta?.content_type ? String(meta.content_type) : null;
          const persona = meta?.persona ? String(meta.persona) : null;
          const { title: contentTitle, body: contentBody } = getContentPreview(meta);
          const hasTags = channel || contentType || persona;
          const hasContent = contentTitle || contentBody;
          return (
            <div className="mb-2 space-y-1.5">
              {issue.description && (
                <DescriptionDropdown description={issue.description} defaultOpen={!hasContent} />
              )}
              {hasTags && (
                <div className="flex flex-wrap gap-1">
                  {channel && (
                    <span className={cn("inline-flex rounded-full px-1.5 py-0 text-[10px] font-medium leading-4", CHANNEL_COLORS[channel] ?? "bg-muted text-muted-foreground")}>
                      {channel}
                    </span>
                  )}
                  {contentType && (
                    <span className="inline-flex rounded-full bg-muted px-1.5 py-0 text-[10px] font-medium leading-4 text-muted-foreground">
                      {contentType.replace(/_/g, " ")}
                    </span>
                  )}
                  {persona && (
                    <span className="inline-flex rounded-full bg-violet-500/15 px-1.5 py-0 text-[10px] font-medium leading-4 text-violet-600 dark:text-violet-400">
                      {persona}
                    </span>
                  )}
                </div>
              )}
              {contentTitle && (
                <p className="text-sm leading-relaxed font-medium text-foreground/70">
                  {contentTitle}
                </p>
              )}
              {contentBody && (
                <p className="text-sm leading-relaxed text-muted-foreground line-clamp-2">
                  {contentBody}
                </p>
              )}
            </div>
          );
        })()}
        {(issue.labels ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {(issue.labels ?? []).slice(0, 3).map((label) => (
              <span
                key={label.id}
                className="inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium leading-4"
                style={{
                  borderColor: label.color,
                  color: pickTextColorForPillBg(label.color, 0.12),
                  backgroundColor: `${label.color}1f`,
                }}
              >
                {label.name}
              </span>
            ))}
            {(issue.labels ?? []).length > 3 && (
              <span className="text-[10px] text-muted-foreground leading-4">
                +{(issue.labels ?? []).length - 3}
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <PriorityIcon priority={issue.priority} />
          {issue.assigneeAgentId && (() => {
            const name = agentName(issue.assigneeAgentId);
            return name ? (
              <Identity name={name} size="xs" />
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                {issue.assigneeAgentId.slice(0, 8)}
              </span>
            );
          })()}
          {(() => {
            const meta = issue.metadata as Record<string, unknown> | null | undefined;
            const extUrl = getExternalUrl(meta);
            if (!extUrl) return null;
            const commentText = String(meta?.draft_body ?? meta?.content ?? meta?.posted_text ?? "");
            return (
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-orange-600 dark:text-orange-400 bg-orange-500/10 hover:bg-orange-500/20 transition-colors cursor-pointer"
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (commentText) {
                    await navigator.clipboard.writeText(commentText);
                  }
                  window.open(extUrl, "_blank", "noopener,noreferrer");
                }}
                title={commentText ? "Copy comment & open Reddit" : "Open Reddit post"}
              >
                <ExternalLink className="h-3 w-3" />
                Reddit
              </button>
            );
          })()}
        </div>
      </Link>
    </div>
  );
}

/* ── Main Board ── */

const COLLAPSED_KEY = "kanban-collapsed-columns";

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function saveCollapsed(set: Set<string>) {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
}

export function KanbanBoard({
  issues,
  agents,
  liveIssueIds,
  onUpdateIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(loadCollapsed);

  useEffect(() => {
    saveCollapsed(collapsedColumns);
  }, [collapsedColumns]);

  const toggleCollapse = useCallback((status: string) => {
    setCollapsedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const topScrollRef = useRef<HTMLDivElement>(null);
  const boardScrollRef = useRef<HTMLDivElement>(null);
  const [scrollWidth, setScrollWidth] = useState(0);
  const syncing = useRef(false);

  useEffect(() => {
    const board = boardScrollRef.current;
    if (!board) return;
    const ro = new ResizeObserver(() => setScrollWidth(board.scrollWidth));
    ro.observe(board);
    setScrollWidth(board.scrollWidth);
    return () => ro.disconnect();
  }, [collapsedColumns, issues]);

  const syncScroll = useCallback((source: "top" | "board") => {
    if (syncing.current) return;
    syncing.current = true;
    const from = source === "top" ? topScrollRef.current : boardScrollRef.current;
    const to = source === "top" ? boardScrollRef.current : topScrollRef.current;
    if (from && to) to.scrollLeft = from.scrollLeft;
    syncing.current = false;
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const columnIssues = useMemo(() => {
    const grouped: Record<string, Issue[]> = {};
    for (const status of boardStatuses) {
      grouped[status] = [];
    }
    for (const issue of issues) {
      if (grouped[issue.status]) {
        grouped[issue.status].push(issue);
      }
    }
    return grouped;
  }, [issues]);

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    // Determine target status: the "over" could be a column id (status string)
    // or another card's id. Find which column the "over" belongs to.
    let targetStatus: string | null = null;

    if (boardStatuses.includes(over.id as string)) {
      targetStatus = over.id as string;
    } else {
      // It's a card - find which column it's in
      const targetIssue = issues.find((i) => i.id === over.id);
      if (targetIssue) {
        targetStatus = targetIssue.status;
      }
    }

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus });
    }
  }

  function handleDragOver(_event: DragOverEvent) {
    // Could be used for visual feedback; keeping simple for now
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div
        ref={topScrollRef}
        className="overflow-x-auto -mx-2 px-2"
        onScroll={() => syncScroll("top")}
      >
        <div style={{ width: scrollWidth, height: 1 }} />
      </div>
      <div
        ref={boardScrollRef}
        className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2"
        onScroll={() => syncScroll("board")}
      >
        {boardStatuses.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            issues={columnIssues[status] ?? []}
            agents={agents}
            liveIssueIds={liveIssueIds}
            collapsed={collapsedColumns.has(status)}
            onToggleCollapse={() => toggleCollapse(status)}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard issue={activeIssue} agents={agents} isOverlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
