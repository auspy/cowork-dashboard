/**
 * Cowork Session Sync Service
 *
 * Reads Cowork scheduled-task session files from the Mac and syncs them
 * into Paperclip's heartbeat_runs table + updates agent statuses.
 * Also syncs SKILL.md files into agent capabilities on first run.
 *
 * Runs inside the server process — no separate script needed.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { eq, and, sql } from "drizzle-orm";

const SYNC_INTERVAL = 60_000;
const SESSION_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Claude/local-agent-mode-sessions",
);
const SKILLS_DIR = path.join(os.homedir(), "Documents/Claude/Scheduled");

interface ParsedSession {
  sessionId: string;
  taskName: string;
  title: string;
  model: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  isRunning: boolean;
}

function findSessionDir(): string | null {
  if (!fs.existsSync(SESSION_DIR)) return null;
  // Find the first account/project directory containing local_*.json files
  for (const accountDir of fs.readdirSync(SESSION_DIR)) {
    const accountPath = path.join(SESSION_DIR, accountDir);
    if (!fs.statSync(accountPath).isDirectory()) continue;
    for (const projectDir of fs.readdirSync(accountPath)) {
      const projectPath = path.join(accountPath, projectDir);
      if (!fs.statSync(projectPath).isDirectory()) continue;
      const hasSessionFiles = fs.readdirSync(projectPath).some(
        (f) => f.startsWith("local_") && f.endsWith(".json"),
      );
      if (hasSessionFiles) return projectPath;
    }
  }
  return null;
}

function parseSessionFile(filePath: string): ParsedSession | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const msg: string = data.initialMessage || "";
    if (!msg.includes("scheduled-task")) return null;

    const nameMatch = msg.match(/name="([^"]+)"/);
    if (!nameMatch) return null;

    return {
      sessionId: data.sessionId,
      taskName: nameMatch[1],
      title: data.title || "",
      model: data.model || "unknown",
      startedAt: data.createdAt ? new Date(data.createdAt) : null,
      finishedAt: data.lastActivityAt ? new Date(data.lastActivityAt) : null,
      isRunning: !data.isArchived,
    };
  } catch {
    return null;
  }
}

export function startCoworkSync(db: Db, companyId: string) {
  const maybeDir = findSessionDir();
  if (!maybeDir) {
    console.log("[cowork-sync] No Cowork session directory found — sync disabled");
    return;
  }
  const sessionDir: string = maybeDir;

  console.log(`[cowork-sync] Watching ${sessionDir}`);
  const syncedSessionIds = new Set<string>();
  let skillsSynced = false;

  async function syncSkills() {
    if (skillsSynced || !fs.existsSync(SKILLS_DIR)) return;

    const agentRows = await db.select({ id: agents.id, name: agents.name, capabilities: agents.capabilities })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const agentMap = new Map(agentRows.map((a) => [a.name, a]));

    let updated = 0;
    for (const dir of fs.readdirSync(SKILLS_DIR)) {
      const skillFile = path.join(SKILLS_DIR, dir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;

      const content = fs.readFileSync(skillFile, "utf8");
      const agent = agentMap.get(dir);
      if (!agent) continue;

      // Skip if already has capabilities content
      if (agent.capabilities && agent.capabilities.length > 100) continue;

      const descMatch = content.match(/^description:\s*(.+)$/m);
      const description = descMatch ? descMatch[1].trim() : null;

      await db.update(agents)
        .set({
          capabilities: content.slice(0, 10000),
          ...(description ? { title: description } : {}),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agent.id));
      updated++;
    }

    if (updated > 0) console.log(`[cowork-sync] Synced ${updated} agent skill definitions`);
    skillsSynced = true;
  }

  async function syncRuns() {
    const agentRows = await db.select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const agentMap = new Map(agentRows.map((a) => [a.name, a.id]));

    // Find DB sessions currently marked as running
    const runningRows = await db.select({ externalRunId: heartbeatRuns.externalRunId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
    const dbRunningIds = new Set(runningRows.map((r) => r.externalRunId).filter(Boolean));

    // Scan session files
    const allFiles = fs.readdirSync(sessionDir).filter(
      (f) => f.startsWith("local_") && f.endsWith(".json"),
    );

    let synced = 0;
    let skippedKnown = 0;
    const syncedNames: string[] = [];

    for (const file of allFiles) {
      const filePath = path.join(sessionDir, file);
      const session = parseSessionFile(filePath);
      if (!session) continue;

      const agentId = agentMap.get(session.taskName);
      if (!agentId) {
        syncedSessionIds.add(session.sessionId);
        continue;
      }

      // Already synced and not running — skip
      if (syncedSessionIds.has(session.sessionId) && !session.isRunning) {
        skippedKnown++;
        // Session finished — mark succeeded if DB still has it as running
        if (dbRunningIds.has(session.sessionId)) {
          await db.update(heartbeatRuns)
            .set({
              status: "succeeded",
              finishedAt: session.finishedAt,
              updatedAt: new Date(),
            })
            .where(and(
              eq(heartbeatRuns.externalRunId, session.sessionId),
              eq(heartbeatRuns.status, "running"),
            ));
        }
        continue;
      }

      // Running sessions always re-insert (they may have been reaped)
      // Completed sessions only insert if not yet synced
      const status = session.isRunning ? "running" : "succeeded";
      try {
        await db.execute(sql`
          INSERT INTO heartbeat_runs (company_id, agent_id, invocation_source, trigger_detail, status, started_at, finished_at, result_json, external_run_id)
          VALUES (${companyId}, ${agentId}, 'scheduled', ${session.title}, ${status}, ${session.startedAt}, ${session.isRunning ? null : session.finishedAt}, ${JSON.stringify({ model: session.model })}::jsonb, ${session.sessionId})
          ON CONFLICT (external_run_id) WHERE external_run_id IS NOT NULL DO NOTHING
        `);
        synced++;
        syncedNames.push(session.isRunning ? `${session.taskName} (running)` : session.taskName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate")) {
          console.error(`[cowork-sync] Insert failed for ${session.taskName}: ${msg}`);
        }
      }

      syncedSessionIds.add(session.sessionId);
    }

    // Update agent statuses
    const currentlyRunning = await db.select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
    const runningAgentIds = new Set(currentlyRunning.map((r) => r.agentId));

    for (const [name, id] of agentMap) {
      if (runningAgentIds.has(id)) {
        await db.update(agents).set({ status: "running", updatedAt: new Date() })
          .where(and(eq(agents.id, id), sql`${agents.status} != 'running'`));
      } else {
        await db.update(agents).set({ status: "idle", updatedAt: new Date() })
          .where(and(eq(agents.id, id), eq(agents.status, "running")));
      }
    }

    const now = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
    if (synced > 0) {
      const unique = [...new Set(syncedNames)];
      console.log(`[cowork-sync ${now}] Synced ${synced} runs (${unique.join(", ")})`);
    }
    console.log(`[cowork-sync ${now}] Scanned ${allFiles.length} files, ${synced} new, ${skippedKnown} known, ${dbRunningIds.size} running in DB`);
  }

  async function run() {
    try {
      await syncSkills();
      await syncRuns();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cowork-sync] Error: ${msg}`);
    }
  }

  // Initial sync + interval
  void run();
  const timer = setInterval(() => void run(), SYNC_INTERVAL);

  // Return cleanup function
  return () => clearInterval(timer);
}
