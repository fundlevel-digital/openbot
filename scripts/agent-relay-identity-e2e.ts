/**
 * Drives the real Agent Relay identity synchronizer (`scripts/hosting/agent-relay/identity-sync.py`)
 * against a temporary OpenBot database and a temporary history index. All rows are built here.
 *
 *   bun scripts/agent-relay-identity-e2e.ts
 *
 * By default the history index has a minimal schema written for this test (MINIMAL_SCHEMA): only
 * the tables and columns that the synchronizer reads or writes, and two change-feed triggers that
 * advance `revision`. The schema of the real index belongs to another product and is not in this
 * repository. To test against the real layout, make a local dump on the server, as the OpenBot user,
 * with a read-only query, and keep the file out of Git:
 *
 *   python3 -c 'import json,sqlite3,sys; db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True);
 *     print(json.dumps([{"type":t,"name":n,"sql":s} for t,n,s in db.execute(
 *     "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE \"sqlite_%\"")]))'
 *     <history.db> > history-schema.json
 *
 *   OPENBOT_AGENT_RELAY_HISTORY_SCHEMA=/path/outside/the/repository/history-schema.json \
 *     bun scripts/agent-relay-identity-e2e.ts
 *
 * First the released synchronizer (from git commit RELEASED) labels the exact sessions. Then the
 * current file runs. Checks: the exact mapping and its marker do not change; a workspace side run
 * gets the agent's name with the `workspace` kind; a child and a grandchild of an attributed
 * session get the name with the `parent` kind; a path that only has the workspace as a string
 * prefix, a deleted agent's workspace, a shared folder, a temporary folder and `cwd` "/" stay
 * without a name; conflicting evidence stays without a name; a parent cycle ends; a name from
 * another source is kept; the dry run changes nothing; originals are saved once; a second run
 * changes nothing and makes no new revision; an unknown schema is refused.
 * Writes .openbot-build/agent-relay-identity-e2e/report.json.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("agent-relay-identity-e2e");
const ROOT = resolve(import.meta.dir, "..");
const HELPER = join(ROOT, "scripts", "hosting", "agent-relay", "identity-sync.py");
const REAL_SCHEMA = process.env.OPENBOT_AGENT_RELAY_HISTORY_SCHEMA;
const REPORT_DIRECTORY = join(ROOT, ".openbot-build", "agent-relay-identity-e2e");
/** The commit with the released synchronizer, before side-run attribution. */
const RELEASED = "1090e7710b";
const SERVER = "e2e";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  logger.info(`${pass ? "PASS" : "FAIL"} ${name}`, { detail });
}
function parseRecord(text: string): DynamicRecord {
  const value = JSON.parse(text);
  if (!isDynamicRecord(value)) throw new Error("JSON value is not an object");
  return value;
}
function recordAt(value: unknown, key: string): DynamicRecord {
  const child = isDynamicRecord(value) ? value[key] : undefined;
  return isDynamicRecord(child) ? child : {};
}

// ---------------------------------------------------------------- fixtures

const root = mkdtempSync(join(process.platform === "darwin" ? tmpdir() : "/tmp", "obi-"));
const home = join(root, "home");
const agentsDir = join(home, "OpenBot", "Agents");
const stateDir = join(home, ".local", "state", "openbot-agent-relay");
const historyPath = join(root, "history.db");
mkdirSync(join(home, ".config", "OpenBot"), { recursive: true });

const tony = { id: "a1tony", name: "Tony", workspacePath: join(agentsDir, "agent-a1tony") };
const maya = { id: "a2maya", name: "Maya", workspacePath: join(agentsDir, "agent-a2maya") };
for (const agent of [tony, maya]) mkdirSync(agent.workspacePath, { recursive: true });
const tonyName = `openbot-${SERVER}-tony`;

const app = new Database(join(home, ".config", "OpenBot", "openbot.db"));
app.run("CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)");
app.run("CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, active_turn_id TEXT)");
app.run(
  "CREATE TABLE projection_provider_sessions (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT NOT NULL, external_session_id TEXT, updated_at TEXT NOT NULL)",
);
for (const agent of [tony, maya])
  app.run("INSERT INTO projection_agents VALUES (?, ?)", [agent.id, JSON.stringify(agent)]);
app.run("INSERT INTO projection_threads VALUES ('t-tony', 'a1tony', NULL)");
app.run("INSERT INTO projection_threads VALUES ('t-gone', 'a9gone', NULL)");
app.run("INSERT INTO projection_provider_sessions VALUES ('p1', 't-tony', 'codex', 's-exact-tony', '2026-11-16')");
app.run(
  "INSERT INTO projection_provider_sessions VALUES ('p2', 't-gone', 'codex', 's-removed-conversation', '2026-11-16')",
);
app.close();

/**
 * Written for this test. The synchronizer depends on these table and column names, and on the two
 * trigger names (the sessions trigger must use NEW.agent_name). The trigger bodies are our own: a
 * change of agent_name or of a marker advances one clock and copies it into `revision`.
 */
const MINIMAL_SCHEMA = [
  `CREATE TABLE sessions (source TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT,
    workspace_roots_json TEXT, agent_name TEXT, revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, session_id))`,
  `CREATE TABLE session_markers (source TEXT NOT NULL, session_id TEXT NOT NULL, marker_uid TEXT NOT NULL,
    kind TEXT NOT NULL, subkind TEXT, text TEXT, payload_json TEXT, location TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, UNIQUE (source, session_id, marker_uid))`,
  "CREATE TABLE session_relationships (source TEXT NOT NULL, parent_session_id TEXT NOT NULL, child_session_id TEXT)",
  "CREATE TABLE e2e_clock (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
  "INSERT INTO e2e_clock VALUES (1, 0)",
  `CREATE TRIGGER change_feed_sessions_update AFTER UPDATE OF agent_name ON sessions
    WHEN NEW.agent_name IS NOT OLD.agent_name BEGIN
      UPDATE e2e_clock SET version = version + 1;
      UPDATE sessions SET revision = (SELECT version FROM e2e_clock) WHERE rowid = NEW.rowid;
    END`,
  `CREATE TRIGGER change_feed_session_markers_insert AFTER INSERT ON session_markers BEGIN
      UPDATE e2e_clock SET version = version + 1;
      UPDATE session_markers SET revision = (SELECT version FROM e2e_clock) WHERE rowid = NEW.rowid;
    END`,
  `CREATE TRIGGER e2e_session_markers_update AFTER UPDATE OF payload_json, text ON session_markers
    WHEN NEW.payload_json IS NOT OLD.payload_json OR NEW.text IS NOT OLD.text BEGIN
      UPDATE e2e_clock SET version = version + 1;
      UPDATE session_markers SET revision = (SELECT version FROM e2e_clock) WHERE rowid = NEW.rowid;
    END`,
];

/** Statements from a local dump of the real schema: tables, then indexes and views, then triggers. */
function realSchema(path: string): string[] {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const list = isDynamicRecord(parsed) ? parsed.objects : parsed;
  const objects = (Array.isArray(list) ? list : []).filter(isDynamicRecord);
  // FTS5 makes its own shadow tables, so they are not created again.
  const virtualTables = objects
    .filter((item) => isString(item.sql) && /^CREATE VIRTUAL TABLE/i.test(item.sql))
    .map((item) => String(item.name));
  const shadow = (name: string) =>
    virtualTables.some((table) => new RegExp(`^${table}_(config|data|docsize|idx|content)$`).test(name));
  const statements: string[] = [];
  for (const type of ["table", "index", "view", "trigger"]) {
    for (const item of objects) {
      if (item.type === type && isString(item.sql) && isString(item.name) && !shadow(item.name))
        statements.push(item.sql);
    }
  }
  statements.push("INSERT INTO observation_clock (singleton, version) VALUES (1, 0)");
  return statements;
}

const schemaMode = REAL_SCHEMA ? "real-dump" : "minimal";
const clockQuery = REAL_SCHEMA ? "SELECT version FROM observation_clock" : "SELECT version FROM e2e_clock";
const statements = REAL_SCHEMA ? realSchema(REAL_SCHEMA) : MINIMAL_SCHEMA;
const history = new Database(historyPath);
for (const statement of statements) history.run(statement);
const outside = "/srv/e2e-project";
const sessions: [string, string, string, string | null, string | null][] = [
  ["codex", "s-exact-tony", tony.workspacePath, null, null],
  ["codex", "s-side-tony", join(tony.workspacePath, "work", "session-review"), null, null],
  ["codex", "s-child", outside, null, null],
  ["codex", "s-grandchild", join(outside, "sub"), null, null],
  ["codex", "s-prefix-only", `${tony.workspacePath}-old`, null, null],
  ["codex", "s-deleted-agent", join(agentsDir, "agent-a9gone", "work"), null, null],
  ["codex", "s-shared", join(home, "OpenBot", "Shared", "notes"), null, null],
  ["grok", "s-root", "/", null, null],
  ["codex", "s-temporary", "/tmp/e2e-scratch", null, null],
  ["codex", "s-conflict-roots", tony.workspacePath, JSON.stringify([maya.workspacePath]), null],
  ["codex", "s-conflict-parent", maya.workspacePath, null, null],
  ["codex", "s-cycle-a", outside, null, null],
  ["codex", "s-cycle-b", outside, null, null],
  ["codex", "s-foreign-name", tony.workspacePath, null, "grok-build-plan"],
  ["codex", "s-removed-conversation", tony.workspacePath, null, null],
];
for (const [source, id, cwd, roots, name] of sessions) {
  history.run(
    "INSERT INTO sessions (session_id, source, cwd, workspace_roots_json, agent_name) VALUES (?, ?, ?, ?, ?)",
    [id, source, cwd, roots, name],
  );
}
const relationships: [string, string][] = [
  ["s-exact-tony", "s-child"],
  ["s-child", "s-grandchild"],
  ["s-exact-tony", "s-conflict-parent"],
  ["s-cycle-a", "s-cycle-b"],
  ["s-cycle-b", "s-cycle-a"],
];
for (const [parent, child] of relationships) {
  if (REAL_SCHEMA)
    history.run(
      "INSERT INTO session_relationships (source, parent_session_id, relationship_uid, child_session_id, relationship, identity_status, evidence_kind, created_ms, updated_ms) VALUES ('codex', ?, ?, ?, 'delegated', 'observed', 'e2e', 0, 0)",
      [parent, `rel-${child}`, child],
    );
  else
    history.run(
      "INSERT INTO session_relationships (source, parent_session_id, child_session_id) VALUES ('codex', ?, ?)",
      [parent, child],
    );
}
history.close();

// ---------------------------------------------------------------- helpers

interface Snapshot {
  sessions: Map<string, { name: string | null; revision: number }>;
  markers: Map<string, { payload: string; revision: number }>;
  clock: number;
}
function snapshot(path = historyPath): Snapshot {
  const db = new Database(path, { readonly: true });
  const result: Snapshot = { sessions: new Map(), markers: new Map(), clock: 0 };
  for (const row of db.query("SELECT session_id, agent_name, revision FROM sessions").all()) {
    if (isDynamicRecord(row) && isString(row.session_id))
      result.sessions.set(row.session_id, {
        name: isString(row.agent_name) ? row.agent_name : null,
        revision: Number(row.revision),
      });
  }
  for (const row of db
    .query("SELECT session_id, payload_json, revision FROM session_markers WHERE subkind='openbot_identity'")
    .all()) {
    if (isDynamicRecord(row) && isString(row.session_id))
      result.markers.set(row.session_id, { payload: String(row.payload_json), revision: Number(row.revision) });
  }
  const clock = db.query(clockQuery).get();
  result.clock = isDynamicRecord(clock) ? Number(clock.version) : -1;
  db.close();
  return result;
}
function digestTree(directory: string): string {
  const hash = createHash("sha256");
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else hash.update(path).update(readFileSync(path));
    }
  };
  walk(directory);
  return hash.digest("hex");
}
function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
async function sync(script: string, extra: string[] = [], historyFile = historyPath) {
  const child = Bun.spawn(
    ["python3", script, "--home", home, "--history", historyFile, "--server", SERVER, "--once", ...extra],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const lines = stdout.trim().split("\n").filter(Boolean);
  const last = lines.at(-1);
  return { code, report: last ? parseRecord(last) : {}, stderr: stderr.trim() };
}
function marker(snap: Snapshot, id: string): DynamicRecord {
  const value = snap.markers.get(id);
  return value ? parseRecord(value.payload) : {};
}

// ---------------------------------------------------------------- run

try {
  // 1. The released synchronizer labels the exact session.
  const released = join(root, "identity-sync-released.py");
  const show = Bun.spawnSync(["git", "show", `${RELEASED}:scripts/hosting/agent-relay/identity-sync.py`], {
    cwd: ROOT,
  });
  if (show.exitCode !== 0) throw new Error("Cannot read the released synchronizer from git");
  writeFileSync(released, show.stdout);
  const first = await sync(released);
  const afterReleased = snapshot();
  const originalsPath = join(stateDir, "original-agent-names.json");
  check(
    "released synchronizer labels the exact session",
    first.code === 0 && afterReleased.sessions.get("s-exact-tony")?.name === tonyName,
    JSON.stringify(first.report),
  );

  // 2. Dry run of the current file changes nothing.
  const historyBefore = digestFile(historyPath);
  const homeBefore = digestTree(home);
  const dry = await sync(HELPER, ["--dry-run"]);
  check(
    "dry run changes nothing",
    dry.code === 0 &&
      digestFile(historyPath) === historyBefore &&
      digestTree(home) === homeBefore &&
      dry.report.workspace_sessions === 1 &&
      dry.report.parent_sessions === 2 &&
      Number(dry.report.metadata_changes) > 0,
    JSON.stringify(dry.report),
  );

  // 3. Current file, first run.
  const second = await sync(HELPER);
  const afterCurrent = snapshot();
  const exactBefore = afterReleased.sessions.get("s-exact-tony");
  const exactAfter = afterCurrent.sessions.get("s-exact-tony");
  check(
    "exact mapping and its marker are unchanged",
    second.code === 0 &&
      exactAfter?.name === exactBefore?.name &&
      exactAfter?.revision === exactBefore?.revision &&
      afterCurrent.markers.get("s-exact-tony")?.payload === afterReleased.markers.get("s-exact-tony")?.payload &&
      afterCurrent.markers.get("s-exact-tony")?.revision === afterReleased.markers.get("s-exact-tony")?.revision &&
      second.report.mapped_sessions === 1,
    JSON.stringify(marker(afterCurrent, "s-exact-tony")),
  );
  const side = marker(afterCurrent, "s-side-tony");
  check(
    "workspace side run gets the agent's name with the workspace kind",
    afterCurrent.sessions.get("s-side-tony")?.name === tonyName &&
      side.attribution_kind === "workspace" &&
      side.attribution === "openbot_agent_workspace" &&
      side.relay_name === tonyName &&
      !("openbot_thread_id" in side),
    JSON.stringify(side),
  );
  const child = marker(afterCurrent, "s-child");
  const grandchild = marker(afterCurrent, "s-grandchild");
  check(
    "child and grandchild get the name through the parent rule",
    afterCurrent.sessions.get("s-child")?.name === tonyName &&
      afterCurrent.sessions.get("s-grandchild")?.name === tonyName &&
      child.attribution_kind === "parent" &&
      child.parent_session_id === "s-exact-tony" &&
      grandchild.attribution_kind === "parent" &&
      grandchild.parent_session_id === "s-child" &&
      !("openbot_thread_id" in child),
    JSON.stringify({ child, grandchild }),
  );
  const unnamedIds = [
    "s-prefix-only",
    "s-deleted-agent",
    "s-shared",
    "s-root",
    "s-temporary",
    "s-conflict-roots",
    "s-conflict-parent",
    "s-cycle-a",
    "s-cycle-b",
    "s-removed-conversation",
  ];
  const reasons = recordAt(second.report, "unnamed_by_reason");
  check(
    "string-prefix path, deleted agent, shared folder, temporary folder and cwd / stay without a name",
    ["s-prefix-only", "s-deleted-agent", "s-shared", "s-root", "s-temporary"].every(
      (id) => afterCurrent.sessions.get(id)?.name === null && !afterCurrent.markers.has(id),
    ) &&
      reasons.unknown_agent_workspace === 2 &&
      reasons.shared_directory === 1 &&
      reasons.root_directory === 1 &&
      reasons.temporary_directory === 1,
    JSON.stringify(reasons),
  );
  check(
    "conflicting evidence stays without a name",
    ["s-conflict-roots", "s-conflict-parent"].every((id) => afterCurrent.sessions.get(id)?.name === null) &&
      reasons.conflicting_evidence === 2,
    JSON.stringify({ conflicting: reasons.conflicting_evidence }),
  );
  check(
    "a parent cycle ends without a name, and a deleted agent's conversation stays without a name",
    afterCurrent.sessions.get("s-cycle-a")?.name === null &&
      afterCurrent.sessions.get("s-cycle-b")?.name === null &&
      reasons.outside_agent_workspaces === 2 &&
      reasons.removed_agent_conversation === 1 &&
      second.report.unnamed_sessions === unnamedIds.length,
    JSON.stringify({ unnamed: second.report.unnamed_sessions }),
  );
  check(
    "a name from another source is kept",
    afterCurrent.sessions.get("s-foreign-name")?.name === "grok-build-plan" &&
      afterCurrent.sessions.get("s-foreign-name")?.revision ===
        afterReleased.sessions.get("s-foreign-name")?.revision &&
      second.report.kept_other_name === 1,
    JSON.stringify({ kept: second.report.kept_other_name }),
  );
  check(
    "report keeps the released keys",
    [
      "bots",
      "mapped_sessions",
      "instruction_changes",
      "metadata_changes",
      "unmatched_sessions",
      "not_yet_captured",
      "instruction_errors",
    ].every((key) => key in second.report) &&
      second.report.unmatched_sessions === 1 &&
      second.report.workspace_sessions === 1 &&
      second.report.parent_sessions === 2,
    JSON.stringify(second.report),
  );
  const originals = parseRecord(readFileSync(originalsPath, "utf8"));
  const originalsDigest = digestFile(originalsPath);
  check(
    "originals are saved before the first change",
    Object.keys(originals).length === 4 &&
      Object.values(originals).every((entry) => isDynamicRecord(entry) && entry.agent_name === null),
    JSON.stringify(Object.keys(originals)),
  );

  // 4. A second run changes nothing.
  const third = await sync(HELPER);
  const afterRepeat = snapshot();
  const sameRevisions = [...afterCurrent.sessions].every(
    ([id, value]) => afterRepeat.sessions.get(id)?.revision === value.revision,
  );
  check(
    "second run changes nothing and makes no new revision",
    third.code === 0 &&
      third.report.metadata_changes === 0 &&
      afterRepeat.clock === afterCurrent.clock &&
      sameRevisions &&
      digestFile(originalsPath) === originalsDigest,
    JSON.stringify({ changes: third.report.metadata_changes, clock: [afterCurrent.clock, afterRepeat.clock] }),
  );

  // 5. Unknown schemas are refused before any change.
  for (const [label, statement, expected] of [
    ["change trigger", "DROP TRIGGER change_feed_sessions_update", "history_change_tracking_schema_unrecognized"],
    [
      "relationships table",
      "ALTER TABLE session_relationships RENAME TO session_relationships_old",
      "history_schema_unrecognized",
    ],
  ] as const) {
    const copy = join(root, `unknown-${label.replace(" ", "-")}.db`);
    writeFileSync(copy, readFileSync(historyPath));
    const db = new Database(copy);
    db.run(statement);
    db.close();
    const before = digestFile(copy);
    const refused = await sync(HELPER, [], copy);
    check(
      `unknown schema is refused (${label})`,
      refused.code === 1 && refused.report.error === expected && digestFile(copy) === before,
      JSON.stringify(refused.report),
    );
  }
} catch (error) {
  check("run completed", false, error instanceof Error ? error.message : "unknown error");
}

const passed = checks.every((item) => item.pass);
mkdirSync(REPORT_DIRECTORY, { recursive: true });
// The report names the schema mode and its statement count, never the dump path or its contents.
const reportPath = join(REPORT_DIRECTORY, REAL_SCHEMA ? "report-real-dump.json" : "report.json");
writeFileSync(
  reportPath,
  `${JSON.stringify({ passed, schemaMode, schemaStatements: statements.length, checks }, null, 2)}\n`,
);
rmSync(root, { recursive: true, force: true });
logger.info(passed ? "PASSED" : "FAILED", { reportPath });
process.exitCode = passed ? 0 : 1;
