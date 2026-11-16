/**
 * Drives the real Agent Relay provisioner (`scripts/hosting/agent-relay/relay-provision.py`) and the
 * real messaging helper (`relay-messaging.py serve`) against a local stand-in for the Relaycast HTTP
 * API. All state is in a new temporary folder: an OpenBot home with a SQLite database that has the
 * three tables the helper reads, a credentials file, a config and a workspace key file.
 *
 *   bun scripts/agent-relay-provision-e2e.ts
 *
 * Checks: a new agent is created and its token is saved; an existing agent is adopted with its
 * current token, keeps that token, and gets its new session metadata; an agent bound to another bot
 * is refused while the others succeed; an agent at the relay with no local token gets
 * `recovery_required`; heartbeats continue for the good agents over two cycles; a name outside the
 * server prefix is refused; a peer with another uid is refused; a non-HTTPS relay origin and a config
 * that root does not own are refused outside test mode; a second sync creates nothing; the workspace
 * key is only sent to workspace endpoints and is in no output, status file, credentials file or log.
 * Each wait is on a request, a process output line or a process exit, with a deadline.
 * Writes .openbot-build/agent-relay-provision-e2e/report.json.
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type DynamicRecord, isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";

/** Parses JSON text that must be an object. */
function parseRecord(text: string): DynamicRecord {
  const value = JSON.parse(text);
  if (!isDynamicRecord(value)) throw new Error("JSON value is not an object");
  return value;
}
function recordAt(value: unknown, key: string): DynamicRecord {
  const child = isDynamicRecord(value) ? value[key] : undefined;
  return isDynamicRecord(child) ? child : {};
}
function stringAt(value: unknown, key: string): string | undefined {
  const child = isDynamicRecord(value) ? value[key] : undefined;
  return isString(child) ? child : undefined;
}
function listAt(value: unknown, key: string): unknown[] {
  const child = isDynamicRecord(value) ? value[key] : undefined;
  return Array.isArray(child) ? child : [];
}

const logger = createOpenBotLogger("agent-relay-provision-e2e");
const ROOT = resolve(import.meta.dir, "..");
const HELPERS = join(ROOT, "scripts", "hosting", "agent-relay");
const REPORT_DIRECTORY = join(ROOT, ".openbot-build", "agent-relay-provision-e2e");
const WAIT_MS = 30_000;
const SERVER = "e2e";
const WORKSPACE = "ws_e2e";
const KEY = `wk_${randomBytes(24).toString("hex")}`;

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

const waiters = new Set<() => void>();
function notify(): void {
  for (const waiter of [...waiters]) waiter();
}
function waitFor<T>(label: string, condition: () => T | undefined | null | false): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      const value = condition();
      if (value) {
        cleanup();
        resolvePromise(value);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out: ${label}`));
    }, WAIT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      waiters.delete(attempt);
    };
    waiters.add(attempt);
    attempt();
  });
}

// ---------------------------------------------------------------- Relaycast stand-in

interface Agent {
  id: string;
  name: string;
  token: string;
  metadata: DynamicRecord;
}
interface Logged {
  method: string;
  path: string;
  auth: "key" | "agent" | "other";
}
const agents = new Map<string, Agent>();
const requests: Logged[] = [];
const heartbeats = new Map<string, number>();
const violations: string[] = [];
let creates = 0;

function token(): string {
  return `tok_${randomBytes(16).toString("hex")}`;
}
function seed(name: string, botId: string, sessionId: string | null): Agent {
  const agent: Agent = {
    id: `agent_${name}`,
    name,
    token: token(),
    metadata: {
      application: "openbot",
      openbot_server_id: SERVER,
      openbot_bot_id: botId,
      session_id: sessionId,
      session_kind: sessionId ? "codex" : null,
      openbot_thread_id: sessionId ? `thread-${botId}` : null,
    },
  };
  agents.set(name, agent);
  return agent;
}
function ok(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}
function publicAgent(agent: Agent) {
  return {
    id: agent.id,
    name: agent.name,
    metadata: agent.metadata,
    created_at: "2026-11-01T00:00:00Z",
    pending_deliveries: 2,
  };
}
const deleted: string[] = [];

const relay = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const owner = [...agents.values()].find((agent) => agent.token === bearer);
    const auth: Logged["auth"] = bearer === KEY ? "key" : owner ? "agent" : "other";
    requests.push({ method: request.method, path: url.pathname, auth });
    queueMicrotask(notify);
    const path = url.pathname;
    const named = /^\/v1\/agents\/([^/]+)$/.exec(path);
    const workspaceRoute =
      path === "/v1/workspace" ||
      (path === "/v1/agents" && request.method === "POST") ||
      (named && named[1] !== "heartbeat");
    if (workspaceRoute) {
      if (auth !== "key") {
        if (auth === "agent") violations.push(`agent token on ${request.method} ${path}`);
        return new Response(null, { status: 401 });
      }
      if (path === "/v1/workspace") return ok({ id: WORKSPACE });
      if (path === "/v1/agents") {
        const body = parseRecord(await request.text());
        const name = stringAt(body, "name");
        if (!name) return new Response(null, { status: 400 });
        if (agents.has(name)) return new Response(null, { status: 409 });
        creates++;
        const agent: Agent = { id: `agent_new_${creates}`, name, token: token(), metadata: recordAt(body, "metadata") };
        agents.set(name, agent);
        return ok({ ...publicAgent(agent), token: agent.token }, 201);
      }
      const agent = agents.get(decodeURIComponent(named?.[1] ?? ""));
      if (!agent) return Response.json({ ok: false, error: { code: "agent_not_found" } }, { status: 404 });
      if (request.method === "DELETE") {
        agents.delete(agent.name);
        deleted.push(agent.name);
        // The reference treats 204 with no body as success.
        return new Response(null, { status: 204 });
      }
      if (request.method === "PATCH") {
        agent.metadata = { ...agent.metadata, ...recordAt(parseRecord(await request.text()), "metadata") };
      }
      return ok(publicAgent(agent));
    }
    if (auth === "key") violations.push(`workspace key on ${request.method} ${path}`);
    if (!owner) return new Response(null, { status: 401 });
    if (path === "/v1/agent" && request.method === "GET") return ok({ id: owner.id, name: owner.name, address: null });
    if (path === "/v1/agent/node-token" && request.method === "POST")
      return ok({ node_id: `node_direct_${owner.id}`, token: `node_${owner.id}` });
    if (path === "/v1/agents/heartbeat" && request.method === "POST") {
      heartbeats.set(owner.name, (heartbeats.get(owner.name) ?? 0) + 1);
      return ok({});
    }
    return new Response(null, { status: 404 });
  },
});
const ORIGIN = `http://127.0.0.1:${relay.port}`;

// ---------------------------------------------------------------- fixtures

const root = mkdtempSync(join(process.platform === "darwin" ? tmpdir() : "/tmp", "obr-"));
const home = join(root, "home");
const stateDir = join(home, ".local", "state", "openbot-agent-relay");
const configDir = join(root, "etc");
const credentialsDir = join(root, "credentials");
mkdirSync(join(home, ".config", "OpenBot"), { recursive: true });
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(configDir, { mode: 0o755 });
mkdirSync(credentialsDir, { mode: 0o700 });
writeFileSync(join(credentialsDir, "workspace-key"), `${KEY}\n`, { mode: 0o600 });
const uid = process.getuid?.() ?? -1;

interface ConfigOverrides {
  relayOrigin?: string;
}
interface ProvisionerOverrides {
  clientUid?: number;
  socket?: string;
}
function writeConfig(file: string, overrides: ConfigOverrides, provisioner: ProvisionerOverrides): string {
  const path = join(configDir, file);
  const config = {
    version: 1,
    serverName: SERVER,
    relayOrigin: ORIGIN,
    relayWorkspaceId: WORKSPACE,
    serviceUser: "openbot",
    serviceHome: home,
    provisioner: {
      clientUid: uid,
      socket: join(root, "p.sock"),
      agentMetadata: { cloud_workspace_id: "cloud_e2e" },
      ...provisioner,
    },
    wake: {},
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o644 });
  chmodSync(path, 0o644);
  return path;
}
const config = writeConfig("config.json", {}, {});
const otherPeerSocket = join(root, "q.sock");
const otherPeerConfig = writeConfig("peer.json", {}, { clientUid: uid + 1, socket: otherPeerSocket });
const insecureConfig = writeConfig("insecure.json", { relayOrigin: "http://relay.example.com" }, {});

const bots = {
  alpha: { id: "bot-alpha", name: "Alpha", relayName: "openbot-e2e-alpha" },
  bravo: { id: "bot-bravo", name: "Bravo", relayName: "openbot-e2e-bravo" },
  charlie: { id: "bot-charlie", name: "Charlie", relayName: "openbot-e2e-charlie" },
  delta: { id: "bot-delta", name: "Delta", relayName: "openbot-e2e-delta" },
  echo: { id: "bot-echo", name: "Echo", relayName: "openbot-e2e-echo" },
};
const sessions: Record<string, string> = {
  "bot-alpha": "alpha-session",
  "bot-bravo": "bravo-new-session",
  "bot-echo": "echo-session",
};

const bravo = seed(bots.bravo.relayName, bots.bravo.id, "bravo-old-session");
seed(bots.charlie.relayName, "bot-someone-else", null);
seed(bots.delta.relayName, bots.delta.id, null);
const echo = seed(bots.echo.relayName, bots.echo.id, "echo-session");

const database = new Database(join(home, ".config", "OpenBot", "openbot.db"));
database.run("CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)");
database.run(
  "CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, active_turn_id TEXT)",
);
database.run(
  "CREATE TABLE projection_provider_sessions (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT NOT NULL, external_session_id TEXT, updated_at TEXT NOT NULL)",
);
for (const bot of Object.values(bots)) {
  const profile = {
    id: bot.id,
    name: bot.name,
    workspacePath: join(home, bot.name),
    ...(bot === bots.echo ? { hiddenAt: "2026-01-01T00:00:00Z" } : {}),
  };
  database.run("INSERT INTO projection_agents VALUES (?, ?)", [bot.id, JSON.stringify(profile)]);
  database.run("INSERT INTO projection_threads VALUES (?, ?, NULL)", [`thread-${bot.id}`, bot.id]);
  const session = sessions[bot.id];
  if (session)
    database.run("INSERT INTO projection_provider_sessions VALUES (?, ?, 'codex', ?, '2026-11-16T00:00:00Z')", [
      `ps-${bot.id}`,
      `thread-${bot.id}`,
      session,
    ]);
}
database.close();

function saved(bot: { id: string; name: string; relayName: string }, agent: Agent, sessionId: string) {
  return {
    agentId: agent.id,
    botId: bot.id,
    botName: bot.name,
    relayName: bot.relayName,
    token: agent.token,
    verified: true,
    profilePresent: true,
    hidden: false,
    sessionId,
    sessionKind: "codex",
    threadId: `thread-${bot.id}`,
  };
}
const credentialsPath = join(stateDir, "messaging-credentials.json");
writeFileSync(
  credentialsPath,
  JSON.stringify({
    version: 1,
    serverId: SERVER,
    serverName: SERVER,
    bots: {
      [bots.bravo.id]: saved(bots.bravo, bravo, "bravo-old-session"),
      [bots.echo.id]: saved(bots.echo, echo, "echo-session"),
    },
  }),
  { mode: 0o600 },
);

// ---------------------------------------------------------------- processes

const outputs: string[] = [];
const baseEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  PYTHONDONTWRITEBYTECODE: "1",
  OPENBOT_AGENT_RELAY_TEST_LOOPBACK: "1",
  OPENBOT_AGENT_RELAY_INTERVAL: "2",
};
interface Running {
  process: Bun.Subprocess;
  text: () => string;
}
const pumps: Promise<void>[] = [];
async function pump(stream: ReadableStream<Uint8Array>, index: number): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    outputs[index] += decoder.decode(chunk);
    notify();
  }
}
function start(script: string, args: string[], env: Record<string, string>): Running {
  const child = Bun.spawn(["python3", join(HELPERS, script), ...args], {
    env: { ...baseEnv, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const index = outputs.push("") - 1;
  pumps.push(pump(child.stdout, index), pump(child.stderr, index), child.exited.then(notify));
  return { process: child, text: () => outputs[index] ?? "" };
}
async function run(script: string, args: string[], env: Record<string, string>, stdin?: string) {
  const child = Bun.spawn(["python3", join(HELPERS, script), ...args], {
    env: { ...baseEnv, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  outputs.push(stdout + stderr);
  return { stdout, stderr, code };
}
function ask(socketPath: string, body: unknown): Promise<DynamicRecord> {
  return new Promise((resolvePromise, reject) => {
    const connection = createConnection({ path: socketPath });
    let data = "";
    connection.on("connect", () => connection.write(`${JSON.stringify(body)}\n`));
    connection.on("data", (chunk) => {
      data += chunk.toString();
    });
    const finish = (error?: Error) => {
      outputs.push(data);
      try {
        resolvePromise(parseRecord(data));
      } catch {
        if (error) resolvePromise({ transportError: error.message });
        else reject(new Error("invalid response"));
      }
    };
    connection.on("end", () => finish());
    // A refused peer can get a reset after the answer, because its request is not read.
    connection.on("error", (error) => finish(error));
    connection.setTimeout(WAIT_MS, () => connection.destroy(new Error("socket timeout")));
  });
}

const provisionEnv = { OPENBOT_AGENT_RELAY_CONFIG: config, CREDENTIALS_DIRECTORY: credentialsDir };
const messagingEnv = { OPENBOT_AGENT_RELAY_CONFIG: config };
const provisioner = start("relay-provision.py", ["serve"], provisionEnv);
const otherPeer = start("relay-provision.py", ["serve"], {
  ...provisionEnv,
  OPENBOT_AGENT_RELAY_CONFIG: otherPeerConfig,
});
const running = [provisioner, otherPeer];
let messaging: Running | undefined;

try {
  await waitFor("provisioner listening", () => provisioner.text().includes('"listening"'));
  await waitFor("second provisioner listening", () => otherPeer.text().includes('"listening"'));

  // A name outside the server prefix, or a name for another bot, is refused before any relay write.
  const createsBefore = creates;
  const outside = await ask(join(root, "p.sock"), {
    agents: [
      { botId: "bot-x", botName: "X", relayName: "conductor-peer", sessionId: null, sessionKind: null, threadId: null },
      {
        botId: "bot-alpha",
        botName: "Alpha",
        relayName: "openbot-e2e-bravo",
        sessionId: null,
        sessionKind: null,
        threadId: null,
      },
      {
        botId: "bot-y",
        botName: "Y",
        relayName: "openbot-other-y",
        sessionId: null,
        sessionKind: null,
        threadId: null,
      },
    ],
  });
  const outsideErrors = listAt(outside, "results").map((result) => stringAt(result, "error"));
  check(
    "name outside the prefix is refused",
    outside.ok === true &&
      outsideErrors.length === 3 &&
      outsideErrors.every((error) => error === "relay_name_refused") &&
      creates === createsBefore,
    JSON.stringify({ errors: outsideErrors, creates: creates - createsBefore }),
  );

  // Malformed requests get an error answer and do not end the provisioner process.
  const pid = provisioner.process.pid;
  const badId = await ask(join(root, "p.sock"), {
    agents: [
      { botId: ["bot-list"], botName: "List", relayName: "openbot-e2e-list" },
      { botId: { nested: true }, botName: "Object", relayName: "openbot-e2e-object" },
    ],
  });
  const notObject = await ask(join(root, "p.sock"), [1, 2, 3]);
  const afterBad = await ask(join(root, "p.sock"), {
    agents: [{ botId: "bot-foxtrot", botName: "Foxtrot", relayName: "openbot-e2e-foxtrot" }],
  });
  const badIdErrors = listAt(badId, "results").map((result) => stringAt(result, "error"));
  const afterBadStatus = listAt(afterBad, "results").map((result) => stringAt(result, "status"));
  check(
    "malformed requests are refused and the provisioner keeps running",
    badIdErrors.length === 2 &&
      badIdErrors.every((error) => error === "bot_id_invalid") &&
      notObject.ok === false &&
      notObject.error === "request_invalid" &&
      afterBadStatus[0] === "created" &&
      provisioner.process.pid === pid &&
      provisioner.process.exitCode === null &&
      provisioner.text().split('"listening"').length === 2,
    JSON.stringify({ badIdErrors, notObject, afterBadStatus, pid, samePid: provisioner.process.pid === pid }),
  );

  // The refused peer may get the answer or a reset; the provisioner log and the relay prove the refusal.
  const requestsBeforePeer = requests.length;
  const refusedPeer = await ask(otherPeerSocket, {
    agents: [{ botId: "bot-alpha", botName: "Alpha", relayName: "openbot-e2e-alpha" }],
  });
  await waitFor("peer refusal logged", () => otherPeer.text().includes('"peer_refused"'));
  check(
    "peer with another uid is refused",
    (refusedPeer.error === "peer_refused" || "transportError" in refusedPeer) &&
      refusedPeer.ok !== true &&
      requests.length === requestsBeforePeer,
    JSON.stringify(refusedPeer),
  );

  messaging = start("relay-messaging.py", ["--home", home, "serve"], messagingEnv);
  running.push(messaging);
  const good = [bots.alpha.relayName, bots.bravo.relayName, bots.echo.relayName];
  await waitFor("two heartbeat cycles", () => good.every((name) => (heartbeats.get(name) ?? 0) >= 2));

  const credentials = recordAt(parseRecord(readFileSync(credentialsPath, "utf8")), "bots");
  const status = parseRecord(readFileSync(join(stateDir, "messaging-status.json"), "utf8"));
  const alphaAgent = agents.get(bots.alpha.relayName);
  const alphaSaved = recordAt(credentials, bots.alpha.id);
  check(
    "new agent is created and its token is saved",
    !!alphaAgent &&
      alphaSaved.token === alphaAgent.token &&
      alphaSaved.agentId === alphaAgent.id &&
      alphaSaved.verified === true,
    JSON.stringify({
      created: !!alphaAgent,
      verified: alphaSaved.verified,
      metadataBot: alphaAgent?.metadata.openbot_bot_id,
      session: alphaAgent?.metadata.session_id,
    }),
  );
  check(
    "created agent has the OpenBot binding metadata",
    alphaAgent?.metadata.openbot_server_id === SERVER &&
      alphaAgent.metadata.openbot_bot_id === bots.alpha.id &&
      alphaAgent.metadata.session_id === "alpha-session" &&
      alphaAgent.metadata.cloud_workspace_id === "cloud_e2e",
    JSON.stringify(alphaAgent?.metadata ?? null),
  );
  const bravoSaved = recordAt(credentials, bots.bravo.id);
  check(
    "existing agent is adopted with its current token",
    bravoSaved.token === bravo.token &&
      bravoSaved.agentId === bravo.id &&
      bravo.metadata.session_id === "bravo-new-session" &&
      bravoSaved.sessionId === "bravo-new-session",
    JSON.stringify({
      tokenKept: bravoSaved.token === bravo.token,
      relaySession: bravo.metadata.session_id,
      savedSession: bravoSaved.sessionId,
    }),
  );
  check(
    "adoption keeps the binding metadata",
    bravo.metadata.openbot_server_id === SERVER && bravo.metadata.openbot_bot_id === bots.bravo.id,
    JSON.stringify(bravo.metadata),
  );
  const failures = recordAt(status, "failures");
  check(
    "agent bound to another bot is refused",
    failures[bots.charlie.id] === "identity_conflict" &&
      !(bots.charlie.id in credentials) &&
      agents.get(bots.charlie.relayName)?.metadata.openbot_bot_id === "bot-someone-else",
    JSON.stringify({ label: failures[bots.charlie.id] }),
  );
  check(
    "agent at the relay with no local token needs recovery",
    failures[bots.delta.id] === "recovery_required" && !(bots.delta.id in credentials),
    JSON.stringify({ label: failures[bots.delta.id] }),
  );
  check(
    "heartbeats continue for the good agents",
    good.every((name) => (heartbeats.get(name) ?? 0) >= 2) &&
      !heartbeats.has(bots.charlie.relayName) &&
      !heartbeats.has(bots.delta.relayName),
    JSON.stringify(Object.fromEntries(heartbeats)),
  );
  check(
    "status file reports counts and fixed labels",
    status.state === "degraded" &&
      status.profiles === 5 &&
      status.registered === 3 &&
      status.verified === 3 &&
      status.heartbeats === 3 &&
      status.failed === 2,
    JSON.stringify(status),
  );
  check(
    "hidden flag and profile presence are kept",
    recordAt(credentials, bots.echo.id).hidden === true &&
      Object.values(credentials).every(
        (bot) => isDynamicRecord(bot) && isBoolean(bot.profilePresent) && bot.profilePresent,
      ),
    "",
  );
  const echoSent = requests.some((entry) => entry.auth === "key" && entry.path === `/v1/agents/${bots.echo.relayName}`);
  check("an agent with unchanged session is not sent to the provisioner", !echoSent, `lookup sent: ${echoSent}`);

  messaging.process.kill("SIGTERM");
  await messaging.process.exited;

  const createsAfterServe = creates;
  const sync = await run("relay-messaging.py", ["--home", home, "sync"], messagingEnv);
  const syncResult = parseRecord(sync.stdout);
  const again = recordAt(parseRecord(readFileSync(credentialsPath, "utf8")), "bots");
  check(
    "second sync creates nothing and keeps tokens",
    sync.code === 0 &&
      creates === createsAfterServe &&
      recordAt(again, bots.alpha.id).token === alphaSaved.token &&
      recordAt(again, bots.bravo.id).token === bravo.token &&
      listAt(syncResult, "registered").length === 3 &&
      listAt(syncResult, "failed").length === 2,
    JSON.stringify({
      code: sync.code,
      creates: creates - createsAfterServe,
      registered: listAt(syncResult, "registered").length,
      failed: listAt(syncResult, "failed"),
    }),
  );
  const whoami = await run("relay-messaging.py", ["--home", home, "--bot", bots.alpha.id, "whoami"], messagingEnv);
  const me = parseRecord(whoami.stdout);
  check(
    "whoami keeps its output shape",
    whoami.code === 0 && me.id === alphaAgent?.id && me.name === bots.alpha.relayName && "address" in me,
    whoami.stdout.trim(),
  );

  // Operator recovery of an agent that the relay has but this server has no token for.
  const keyFile = join(credentialsDir, "workspace-key");
  const looseKey = join(credentialsDir, "loose-key");
  writeFileSync(looseKey, "not-the-key", { mode: 0o644 });
  chmodSync(looseKey, 0o644);
  const recoverEnv = { OPENBOT_AGENT_RELAY_CONFIG: config };
  const outsideRecover = await run(
    "relay-provision.py",
    ["recover", "--relay-name", "conductor-peer", "--key-file", keyFile],
    recoverEnv,
  );
  const looseRecover = await run(
    "relay-provision.py",
    ["recover", "--relay-name", bots.delta.relayName, "--key-file", looseKey],
    recoverEnv,
  );
  check(
    "recover refuses a name outside the prefix and a key file that others can read",
    outsideRecover.code === 1 &&
      outsideRecover.stdout.includes("relay_name_refused") &&
      looseRecover.code === 1 &&
      looseRecover.stdout.includes("key_file_permissions") &&
      deleted.length === 0,
    JSON.stringify({ outside: outsideRecover.stdout.trim(), loose: looseRecover.stdout.trim() }),
  );
  const deltaBefore = agents.get(bots.delta.relayName);
  const dryRun = await run(
    "relay-provision.py",
    ["recover", "--relay-name", bots.delta.relayName, "--key-file", keyFile],
    recoverEnv,
  );
  const dry = parseRecord(dryRun.stdout);
  check(
    "recover dry run changes nothing",
    dryRun.code === 0 &&
      dry.applied === false &&
      dry.agentId === deltaBefore?.id &&
      dry.botId === bots.delta.id &&
      dry.pendingDeliveries === 2 &&
      isString(dry.createdAt) &&
      deleted.length === 0 &&
      agents.get(bots.delta.relayName) === deltaBefore,
    dryRun.stdout.trim(),
  );
  const applied = await run(
    "relay-provision.py",
    ["recover", "--relay-name", bots.delta.relayName, "--key-file", keyFile, "--apply"],
    recoverEnv,
  );
  check(
    "recover --apply deletes the agent at the relay",
    applied.code === 0 &&
      parseRecord(applied.stdout).applied === true &&
      deleted.length === 1 &&
      deleted[0] === bots.delta.relayName &&
      !agents.has(bots.delta.relayName),
    applied.stdout.trim(),
  );
  const resync = await run("relay-messaging.py", ["--home", home, "sync"], messagingEnv);
  const deltaAgent = agents.get(bots.delta.relayName);
  const deltaSaved = recordAt(recordAt(parseRecord(readFileSync(credentialsPath, "utf8")), "bots"), bots.delta.id);
  const resyncFailed = listAt(parseRecord(resync.stdout), "failed").map((item) => stringAt(item, "bot_id"));
  check(
    "next sync creates the recovered agent again with a new id and token",
    resync.code === 0 &&
      !!deltaAgent &&
      deltaAgent.id !== deltaBefore?.id &&
      deltaSaved.agentId === deltaAgent.id &&
      deltaSaved.token === deltaAgent.token &&
      deltaSaved.verified === true &&
      resyncFailed.length === 1 &&
      resyncFailed[0] === bots.charlie.id,
    JSON.stringify({ newId: deltaAgent?.id, verified: deltaSaved.verified, failed: resyncFailed }),
  );

  const insecure = await run("relay-provision.py", ["check-config"], { OPENBOT_AGENT_RELAY_CONFIG: insecureConfig });
  check(
    "non-HTTPS origin is refused",
    insecure.code === 1 && insecure.stdout.includes("relay_origin_must_be_https"),
    insecure.stdout.trim(),
  );
  const strict = await run("relay-provision.py", ["check-config"], {
    OPENBOT_AGENT_RELAY_CONFIG: config,
    OPENBOT_AGENT_RELAY_TEST_LOOPBACK: "0",
  });
  check(
    "config not owned by root is refused outside test mode",
    uid === 0 || (strict.code === 1 && strict.stdout.includes("config_permissions")),
    strict.stdout.trim(),
  );

  check(
    "workspace key is used only on workspace endpoints",
    violations.length === 0 && requests.some((entry) => entry.auth === "key"),
    JSON.stringify(violations),
  );
} catch (error) {
  check("run completed", false, error instanceof Error ? error.message : "unknown error");
} finally {
  for (const item of running) item.process.kill("SIGTERM");
  await Promise.all(running.map((item) => item.process.exited));
  await Promise.all(pumps);
  await relay.stop(true);
}

// The key must not appear in any output or in any file except its own credential file.
const leaks: string[] = [];
outputs.forEach((text, index) => {
  if (text.includes(KEY)) leaks.push(`process output ${index}`);
});
function scan(directory: string): void {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isDirectory()) scan(path);
    else if (info.isFile() && path !== join(credentialsDir, "workspace-key") && readFileSync(path).includes(KEY))
      leaks.push(path.slice(root.length));
  }
}
scan(root);
check("workspace key is in no output, status, credentials or log file", leaks.length === 0, JSON.stringify(leaks));
const passed = checks.every((item) => item.pass);
const reportText = JSON.stringify(
  { passed, checks, relayRequests: requests.length, creates, processOutputs: outputs.length, keyLeaks: leaks },
  null,
  2,
);
if (reportText.includes(KEY)) throw new Error("The report would contain the workspace key");
mkdirSync(REPORT_DIRECTORY, { recursive: true });
const reportPath = join(REPORT_DIRECTORY, "report.json");
writeFileSync(reportPath, `${reportText}\n`);
rmSync(root, { recursive: true, force: true });
logger.info(passed ? "PASSED" : "FAILED", { reportPath });
process.exitCode = passed ? 0 : 1;
