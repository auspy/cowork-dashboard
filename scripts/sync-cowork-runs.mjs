#!/usr/bin/env node
/**
 * sync-cowork-runs.mjs
 *
 * Reads Cowork scheduled-task session files from the Mac and syncs them
 * into Paperclip's heartbeat_runs table. Also syncs SKILL.md files into
 * agent capabilities.
 *
 * Usage:
 *   node scripts/sync-cowork-runs.mjs          # one-shot
 *   node scripts/sync-cowork-runs.mjs --watch  # loop every 60s
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// --- Config ---
const COMPANY_ID = "dfbfdf01-cc8c-45e3-aa30-c066be90bc4a";
const SESSION_DIR = path.join(
  process.env.HOME,
  "Library/Application Support/Claude/local-agent-mode-sessions/571981a9-0afa-44df-b303-0a23a5ad2811/c2c9ee61-c1ec-427e-8b7a-38d04ba1417c",
);
const SKILLS_DIR = path.join(process.env.HOME, "Documents/Claude/Scheduled");
const STATE_FILE = new URL(".sync-state.json", import.meta.url).pathname;
const API_BASE = "http://127.0.0.1:3100/api";
const SYNC_INTERVAL = 60_000;

// --- State ---
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { syncedSessionIds: [], skillHashes: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- API helpers ---
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function apiPatch(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path}: ${res.status}`);
  return res.json();
}

// --- Postgres helper (uses psql for simplicity, no npm deps) ---
function psql(sql) {
  const result = execSync(
    `/opt/homebrew/opt/postgresql@17/bin/psql -d paperclip -t -A -c ${escapeShell(sql)}`,
    { encoding: "utf8", timeout: 10_000 },
  );
  return result.trim();
}

function escapeShell(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// --- Parse session files ---
function parseSessionFile(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const msg = data.initialMessage || "";
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
      isArchived: data.isArchived ?? false,
      isRunning: !data.isArchived && data.lastActivityAt && (Date.now() - data.lastActivityAt < 10 * 60_000),
    };
  } catch {
    return null;
  }
}

// --- Sync runs ---
async function syncRuns() {
  const state = loadState();
  const syncedSet = new Set(state.syncedSessionIds);

  // Load agent name → id map
  const agents = await apiGet(`/companies/${COMPANY_ID}/agents`);
  const agentMap = new Map();
  for (const a of agents) {
    agentMap.set(a.name, a.id);
  }

  // Scan session files
  const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json") && f.startsWith("local_"));
  let synced = 0;
  const syncedNames = [];

  for (const file of files) {
    const filePath = path.join(SESSION_DIR, file);
    const session = parseSessionFile(filePath);
    if (!session) continue;

    const agentId = agentMap.get(session.taskName);
    if (!agentId) {
      syncedSet.add(session.sessionId);
      continue;
    }

    const startTs = session.startedAt ? session.startedAt.toISOString() : "NOW()";
    const finishTs = session.finishedAt ? session.finishedAt.toISOString() : startTs;
    const resultJson = JSON.stringify({ model: session.model }).replace(/'/g, "''");
    const triggerDetail = (session.title || "").replace(/'/g, "''");
    const extRunId = session.sessionId.replace(/'/g, "''");
    const status = session.isRunning ? "running" : "succeeded";

    if (syncedSet.has(session.sessionId)) {
      // Already synced — but check if a "running" run has now finished
      if (!session.isRunning) {
        try {
          psql(`
            UPDATE heartbeat_runs SET status = 'succeeded', finished_at = '${finishTs}', updated_at = NOW()
            WHERE external_run_id = '${extRunId}' AND status = 'running'
          `);
        } catch {}
      }
      continue;
    }

    try {
      psql(`
        INSERT INTO heartbeat_runs (company_id, agent_id, invocation_source, trigger_detail, status, started_at, finished_at, result_json, external_run_id)
        VALUES ('${COMPANY_ID}', '${agentId}', 'scheduled', '${triggerDetail}', '${status}', '${startTs}', ${status === 'running' ? 'NULL' : "'" + finishTs + "'"}, '${resultJson}'::jsonb, '${extRunId}')
        ON CONFLICT DO NOTHING
      `);
      synced++;
      syncedNames.push(session.isRunning ? `${session.taskName} (running)` : session.taskName);
    } catch (err) {
      console.error(`  Failed to sync ${session.taskName}: ${err.message}`);
    }

    syncedSet.add(session.sessionId);
  }

  // Update agent statuses based on running heartbeat runs
  const runningAgentIds = new Set();
  try {
    const rows = psql(`SELECT DISTINCT agent_id FROM heartbeat_runs WHERE status = 'running' AND company_id = '${COMPANY_ID}'`);
    if (rows) {
      for (const row of rows.split("\n")) {
        const id = row.trim();
        if (id) runningAgentIds.add(id);
      }
    }
  } catch {}

  for (const [name, id] of agentMap) {
    const shouldBeRunning = runningAgentIds.has(id);
    try {
      if (shouldBeRunning) {
        psql(`UPDATE agents SET status = 'running', updated_at = NOW() WHERE id = '${id}' AND status != 'running'`);
      } else {
        psql(`UPDATE agents SET status = 'idle', updated_at = NOW() WHERE id = '${id}' AND status = 'running'`);
      }
    } catch {}
  }

  // Save state
  state.syncedSessionIds = [...syncedSet];
  saveState(state);

  return { synced, names: syncedNames };
}

// --- Sync SKILL.md → agent capabilities ---
async function syncSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return 0;

  const state = loadState();
  const agents = await apiGet(`/companies/${COMPANY_ID}/agents`);
  const agentMap = new Map();
  for (const a of agents) {
    agentMap.set(a.name, a);
  }

  let updated = 0;
  const dirs = fs.readdirSync(SKILLS_DIR);

  for (const dir of dirs) {
    const skillFile = path.join(SKILLS_DIR, dir, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;

    const content = fs.readFileSync(skillFile, "utf8");
    const hash = simpleHash(content);
    const agent = agentMap.get(dir);
    if (!agent) continue;

    // Skip if unchanged
    if (state.skillHashes[dir] === hash) continue;

    // Extract description from frontmatter
    const descMatch = content.match(/^description:\s*(.+)$/m);
    const description = descMatch ? descMatch[1].trim() : null;

    try {
      await apiPatch(`/agents/${agent.id}`, {
        capabilities: content.slice(0, 10000), // cap at 10k chars
        ...(description ? { title: description } : {}),
      });
      state.skillHashes[dir] = hash;
      updated++;
    } catch (err) {
      console.error(`  Failed to sync skill for ${dir}: ${err.message}`);
    }
  }

  saveState(state);
  return updated;
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

// --- Main ---
async function run() {
  const now = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  try {
    // Sync skills on first run
    const skills = await syncSkills();
    if (skills > 0) console.log(`[cowork-sync ${now}] Synced ${skills} agent skill definitions`);

    // Sync runs
    const { synced, names } = await syncRuns();
    if (synced > 0) {
      const unique = [...new Set(names)];
      console.log(`[cowork-sync ${now}] Synced ${synced} new runs (${unique.join(", ")})`);
    }
  } catch (err) {
    console.error(`[cowork-sync ${now}] Error: ${err.message}`);
  }
}

const watch = process.argv.includes("--watch");

async function waitForApi(maxWait = 120_000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

console.log("[cowork-sync] waiting for API...");
const ready = await waitForApi();
if (!ready) {
  console.error("[cowork-sync] API not available after 2 minutes, exiting");
  process.exit(1);
}

console.log("[cowork-sync] API ready — syncing from:");
console.log(`  Sessions: ${SESSION_DIR}`);
console.log(`  Skills:   ${SKILLS_DIR}`);
console.log(`  Mode:     ${watch ? "watch (60s)" : "one-shot"}\n`);

await run();

if (watch) {
  setInterval(run, SYNC_INTERVAL);
}
