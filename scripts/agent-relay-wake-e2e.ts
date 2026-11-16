/**
 * Drives the real Agent Relay wake listener (`scripts/hosting/agent-relay/recipient-wake.mjs`) as a
 * Node process against local stand-ins: a relay with its HTTP API and node WebSocket, a Hookdeck
 * ingress, and OpenBot's loopback automation server. All state is in a new temporary folder.
 *
 *   bun scripts/agent-relay-wake-e2e.ts
 *
 * Set OPENBOT_AGENT_RELAY_WAKE_NODE to the Node binary that the server runs. Node 22 is the version
 * where the deployed `onerror` handler recursed and ended the process, so use Node 22 when you can.
 *
 * The automation stand-in follows `src/main/automation-server.ts`: `GET /v1/agents` lists only agents
 * with "Local scripts" on that are not hidden, and only their schedule routines (webhook routines are
 * absent and `run` on them is 404); a refused agent gets 403, a hidden agent 409, and an agent over its
 * hourly limit 429; a request takes a rate slot before the host checks the `clientMessageId`, which
 * then returns the first receipt without a second message.
 *
 * The relay stand-in follows the real relay (seen on 2026-11-16): it pushes `deliver` frames only to
 * a socket that sent a valid `node.register` and got its `reply`, replays every unacknowledged row on
 * each register, answers a heartbeat that has an `id`, sends one `ping`, and records any other frame
 * the listener sends (a `delivery.ack` or `delivery.accepted` fails the run).
 *
 * Checks: configured and discovered routes connect, and a route whose agent the server does not list
 * waits; Hookdeck bodies keep their released bytes; a schedule routine runs; a message wake goes out
 * once per delivery with no relay content; a duplicate goes out once; failed WebSocket upgrades on one
 * route do not end the process; 403, 409 and 429 wait without blocking other routes and recover; a
 * configured route replaces a discovered one without a restart; a route with no credential waits and
 * connects; a new credential gets a discovered route; the route tool's dry run changes nothing and
 * `--apply` does not reconnect running routes; the status file has no secret; SIGTERM stops cleanly.
 * Each wait is on an event or a file change, with a deadline.
 * Writes .openbot-build/agent-relay-wake-e2e/report.json.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("agent-relay-wake-e2e");

const ROOT = resolve(import.meta.dir, "..");
const HELPERS = join(ROOT, "scripts", "hosting", "agent-relay");
const REPORT_DIRECTORY = join(ROOT, ".openbot-build", "agent-relay-wake-e2e");
const NODE = process.env.OPENBOT_AGENT_RELAY_WAKE_NODE || "node";
const WAIT_MS = 20_000;
/** `INPUT_LIMITS.identifier` and `INPUT_LIMITS.messageText`. */
const IDENTIFIER_LIMIT = 128;
const MESSAGE_TEXT_LIMIT = 100_000;
const RELAY_CONTENT = "relay content that must not reach OpenBot";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  logger.info(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

/** A JSON object from a file or a string, or null when it is missing or not an object. */
function jsonRecord(text: () => string): DynamicRecord | null {
  try {
    return asRecord(JSON.parse(text()));
  } catch {
    return null;
  }
}
function asRecord(value: unknown): DynamicRecord | null {
  return isDynamicRecord(value) ? value : null;
}
function records(value: unknown): DynamicRecord[] {
  return Array.isArray(value) ? value.filter(isDynamicRecord) : [];
}

// Every source of change calls `notify`; each waiter checks its condition again.
const waiters = new Set<() => void>();
function notify(): void {
  for (const waiter of [...waiters]) waiter();
}
function waitFor<T>(label: string, condition: () => T | undefined | null | false): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      let value: T | undefined | null | false;
      try {
        value = condition();
      } catch {
        value = undefined;
      }
      if (value) {
        cleanup();
        resolvePromise(value);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}.`));
    }, WAIT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      waiters.delete(attempt);
    };
    waiters.add(attempt);
    attempt();
  });
}

interface Bot {
  key: string;
  botId: string;
  agentId: string;
  relayName: string;
  token: string;
}
function makeBot(key: string, index: number): Bot {
  const suffix = `0000000${index}`.slice(-8);
  return {
    key,
    botId: `agent-${suffix}-1111-4111-8111-111111111111`,
    agentId: `90000000000000${1000 + index}`,
    relayName: `openbot-e2e-${key}`,
    token: `relay-token-${key}-${crypto.randomUUID()}`,
  };
}
const bots = {
  a: makeBot("a", 0),
  b: makeBot("b", 1),
  c: makeBot("c", 2),
  d: makeBot("d", 3),
  e: makeBot("e", 4),
  f: makeBot("f", 5),
  g: makeBot("g", 6),
  h: makeBot("h", 7),
  k: makeBot("k", 8),
};
type BotKey = keyof typeof bots;
const byAgent = new Map(Object.values(bots).map((bot) => [bot.agentId, bot]));

const temp = mkdtempSync(join(tmpdir(), "agent-relay-wake-e2e-"));
const stateDir = join(temp, "wake");
const keysDir = join(temp, "keys");
const automationRoot = join(temp, "automation");
const credentialsPath = join(temp, "messaging-credentials.json");
for (const directory of [stateDir, keysDir, automationRoot]) mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(temp, 0o700);

/** Writes a private file in one rename, as the deployed writers do. */
function writePrivate(path: string, value: unknown): void {
  const next = `${path}.e2e.tmp`;
  writeFileSync(next, typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, path);
}

// --- Relay stand-in ---------------------------------------------------------------------------
// It follows what the real relay did on 2026-11-16 and what relaycast's engine does: the socket is
// the agent's delivery provider only after a valid `node.register` (strict keys, as the zod schema);
// the reply is `{type: "reply", ok: true, data: {capabilities: [...]}}`; then every row that is not
// acknowledged is replayed. Before that, a row stays queued. A socket write moves a row to
// `delivered`; only `delivery.ack` would settle it. A `node.heartbeat` with an `id` gets a reply.
interface RelayRow {
  deliveryId: string;
  frame: string;
  status: "queued" | "delivered" | "acked";
}
interface RelaySocketData {
  agentId: string;
  registered: boolean;
}
const REGISTER_KEYS = new Set([
  "v",
  "id",
  "type",
  "name",
  "node_id",
  "provider",
  "capabilities",
  "max_agents",
  "tags",
  "repo_keys",
  "version",
  "machine_id",
  "resume_cursor",
]);
const HEARTBEAT_KEYS = new Set([
  "v",
  "id",
  "type",
  "provider",
  "load",
  "load_reported",
  "active_agents",
  "handlers_live",
  "name",
  "node_id",
  "capabilities",
  "max_agents",
  "version",
]);
const relayOpens = new Map<string, number>();
const failedUpgrades = new Map<string, number>();
const failNextUpgrades = new Map<string, number>();
/** Registered sockets only: the relay pushes to nothing else. */
const relaySockets = new Map<string, Bun.ServerWebSocket<RelaySocketData>>();
const relayRows = new Map<string, RelayRow[]>();
const rejectNextRegister = new Map<string, string>();
/** Frames the listener sent, by agent and type, and the frames the relay refused. */
const listenerFrames: { agentId: string; type: string }[] = [];
const refusedFrames: { agentId: string; type: string; reason: string }[] = [];
const heartbeatsIn = new Map<string, number>();

function hasOnly(frame: DynamicRecord, keys: Set<string>): boolean {
  return Object.keys(frame).every((key) => keys.has(key));
}
function validRegister(frame: DynamicRecord, agentId: string): boolean {
  const provider = asRecord(frame.provider);
  return (
    hasOnly(frame, REGISTER_KEYS) &&
    frame.v === 1 &&
    isString(frame.id) &&
    isString(frame.name) &&
    frame.node_id === `node_direct_${agentId}` &&
    (provider === null || (isString(provider.name) && isString(provider.instance_id))) &&
    Array.isArray(frame.capabilities) &&
    Number.isInteger(frame.max_agents) &&
    Array.isArray(frame.tags) &&
    isString(frame.version)
  );
}
function validHeartbeat(frame: DynamicRecord): boolean {
  return (
    hasOnly(frame, HEARTBEAT_KEYS) && Number.isInteger(frame.active_agents) && typeof frame.handlers_live === "boolean"
  );
}
function pushRow(ws: Bun.ServerWebSocket<RelaySocketData>, row: RelayRow): void {
  ws.send(row.frame);
  if (row.status === "queued") row.status = "delivered";
}
const relay = Bun.serve<RelaySocketData>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const url = new URL(request.url);
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const bot = Object.values(bots).find((candidate) => candidate.token === bearer);
    if (url.pathname === "/v1/agent" && request.method === "GET") {
      if (!bot) return new Response("", { status: 401 });
      return Response.json({ ok: true, data: { id: bot.agentId, name: bot.relayName } });
    }
    if (url.pathname === "/v1/agent/node-token" && request.method === "POST") {
      if (!bot) return new Response("", { status: 401 });
      return Response.json({
        ok: true,
        data: {
          node_id: `node_direct_${bot.agentId}`,
          node_name: `direct-${bot.agentId}`,
          token: `node-${bot.agentId}`,
        },
      });
    }
    if (url.pathname === "/v1/node/ws") {
      const agentId = url.searchParams.get("token")?.replace(/^node-/, "") ?? "";
      if (!byAgent.has(agentId)) return new Response("", { status: 401 });
      const failures = failNextUpgrades.get(agentId) ?? 0;
      if (failures > 0) {
        // A refused upgrade: the error path that ended the deployed process on Node 22.
        failNextUpgrades.set(agentId, failures - 1);
        failedUpgrades.set(agentId, (failedUpgrades.get(agentId) ?? 0) + 1);
        queueMicrotask(notify);
        return new Response("unavailable", { status: 503 });
      }
      if (server.upgrade(request, { data: { agentId, registered: false } })) return undefined;
      return new Response("", { status: 400 });
    }
    return new Response("", { status: 404 });
  },
  websocket: {
    open(ws) {
      relayOpens.set(ws.data.agentId, (relayOpens.get(ws.data.agentId) ?? 0) + 1);
      notify();
    },
    message(ws, raw) {
      const { agentId } = ws.data;
      const frame = jsonRecord(() => String(raw));
      const type = isString(frame?.type) ? frame.type : "invalid";
      listenerFrames.push({ agentId, type });
      if (!frame) return;
      if (type === "node.register") {
        if (!validRegister(frame, agentId)) {
          refusedFrames.push({ agentId, type, reason: "invalid_message" });
          ws.send(JSON.stringify({ v: 1, type: "error", id: frame.id, code: "invalid_message", message: "invalid" }));
          return;
        }
        const rejection = rejectNextRegister.get(agentId);
        if (rejection) {
          rejectNextRegister.delete(agentId);
          refusedFrames.push({ agentId, type, reason: rejection });
          ws.send(JSON.stringify({ v: 1, type: "error", id: frame.id, code: rejection, message: "refused" }));
          notify();
          return;
        }
        ws.data.registered = true;
        relaySockets.set(agentId, ws);
        ws.send(
          JSON.stringify({
            v: 1,
            id: frame.id,
            type: "reply",
            ok: true,
            data: {
              status: "online",
              accepted_capabilities: [],
              capabilities: ["delivery.accepted", "delivery.ack.delivery_id"],
            },
          }),
        );
        ws.send(JSON.stringify({ v: 1, type: "ping" }));
        for (const row of relayRows.get(agentId) ?? []) if (row.status !== "acked") pushRow(ws, row);
        notify();
        return;
      }
      if (type === "node.heartbeat") {
        if (!validHeartbeat(frame)) {
          refusedFrames.push({ agentId, type, reason: "invalid_message" });
          return;
        }
        heartbeatsIn.set(agentId, (heartbeatsIn.get(agentId) ?? 0) + 1);
        if (isString(frame.id) && ws.data.registered)
          ws.send(
            JSON.stringify({
              v: 1,
              id: frame.id,
              type: "reply",
              ok: true,
              data: { agent_presence: true, agent_id: agentId },
            }),
          );
        notify();
        return;
      }
      // `delivery.accepted` and `delivery.ack` would change what the agent's inbox shows.
      refusedFrames.push({ agentId, type, reason: "unexpected" });
      notify();
    },
    close(ws) {
      if (relaySockets.get(ws.data.agentId) === ws) relaySockets.delete(ws.data.agentId);
      notify();
    },
  },
});

/** A new row in the agent's mailbox. The relay pushes it only to a registered socket. */
function deliver(bot: Bot, deliveryId: string, createdAt: string): void {
  const rows = relayRows.get(bot.agentId) ?? [];
  relayRows.set(bot.agentId, rows);
  const row: RelayRow = {
    deliveryId,
    status: "queued",
    frame: JSON.stringify({
      v: 1,
      type: "deliver",
      delivery_id: deliveryId,
      agent_id: bot.agentId,
      agent: bot.relayName,
      msg_id: `msg-${deliveryId}`,
      seq: rows.length + 1,
      mode: "wait",
      payload: { type: "dm.received", data: { created_at: createdAt, text: RELAY_CONTENT } },
    }),
  };
  rows.push(row);
  const socket = relaySockets.get(bot.agentId);
  if (socket?.data.registered) pushRow(socket, row);
}
function rowStatus(bot: Bot, deliveryId: string): string | undefined {
  return relayRows.get(bot.agentId)?.find((row) => row.deliveryId === deliveryId)?.status;
}
/** The released Hookdeck body, written out key by key so that a change in order fails. */
function expectedBody(bot: Bot, deliveryId: string, createdAt: string): string {
  return `{"event_type":"agent-relay.message","delivery_id":"${deliveryId}","message_id":"msg-${deliveryId}","recipient_agent_id":"${bot.agentId}","recipient_bot_id":"${bot.botId}","created_at":"${createdAt}"}`;
}

// --- Hookdeck ingress stand-in ----------------------------------------------------------------
const ingressKeys = new Map(
  Object.values(bots).map((bot) => [bot.key, `ingress-key-${bot.key}-${crypto.randomUUID()}`]),
);
const ingressBodies: { key: string; body: string }[] = [];
const ingress = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const key = new URL(request.url).pathname.replace(/^\/src-/, "");
    if (request.method !== "POST" || request.headers.get("x-api-key") !== ingressKeys.get(key))
      return new Response("", { status: 401 });
    ingressBodies.push({ key, body: await request.text() });
    notify();
    return Response.json({ status: "SUCCESS" });
  },
});
function ingressCount(bot: Bot, deliveryId: string): number {
  return ingressBodies.filter(
    (entry) => entry.key === bot.key && asRecord(JSON.parse(entry.body))?.delivery_id === deliveryId,
  ).length;
}

// --- OpenBot automation server stand-in -------------------------------------------------------
interface StandInAgent {
  allowed: boolean;
  hidden: boolean;
  routines: { id: string; name: string; schedule: boolean }[];
  runsThisHour: number;
}
const RUNS_PER_HOUR = 30;
const automationToken = `automation-token-${crypto.randomUUID()}`;
const standInAgents = new Map<string, StandInAgent>();
function addStandInAgent(bot: Bot, allowed: boolean, routines: StandInAgent["routines"] = []): void {
  standInAgents.set(bot.botId, { allowed, hidden: false, routines, runsThisHour: 0 });
}
function standIn(bot: Bot): StandInAgent {
  const agent = standInAgents.get(bot.botId);
  if (!agent) throw new Error(`No stand-in agent for ${bot.key}.`);
  return agent;
}
for (const key of ["a", "b", "e"] as const) addStandInAgent(bots[key], false);
addStandInAgent(bots.c, true, [
  { id: "routine-c", name: "Inbox sweep", schedule: true },
  { id: "routine-c-webhook", name: "Agent Relay inbox", schedule: false },
]);
addStandInAgent(bots.d, true);
addStandInAgent(bots.f, true);
addStandInAgent(bots.g, false);
addStandInAgent(bots.h, true);
addStandInAgent(bots.k, true);

const automationRuns: { botId: string; routineId: string; payload: string }[] = [];
/** Each accepted message once; a repeated `clientMessageId` is not stored twice, as on the host. */
const automationMessages: { botId: string; clientMessageId: string; text: string }[] = [];
const automationAnswers: { botId: string; route: string; status: number }[] = [];
const automationRefusals: string[] = [];
function answer(botId: string, route: string, status: number, body: unknown = { error: "refused" }): Response {
  automationAnswers.push({ botId, route, status });
  queueMicrotask(notify);
  return Response.json(body, { status });
}
function answers(bot: Bot, status: number): number {
  return automationAnswers.filter((entry) => entry.botId === bot.botId && entry.status === status).length;
}
const automation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    // The same gates as OpenBot's automation server: exact Host, no Origin, bearer token.
    if (request.headers.get("host") !== `127.0.0.1:${automation.port}` || request.headers.has("origin")) {
      automationRefusals.push("host_or_origin");
      return new Response("", { status: 403 });
    }
    if (request.headers.get("authorization") !== `Bearer ${automationToken}`) {
      automationRefusals.push("token");
      return new Response("", { status: 401 });
    }
    const path = new URL(request.url).pathname;
    if (path === "/v1/agents" && request.method === "GET") {
      return Response.json(
        [...standInAgents.entries()]
          .filter(([, agent]) => agent.allowed && !agent.hidden)
          .map(([id, agent]) => ({
            id,
            name: id,
            routines: agent.routines
              .filter((routine) => routine.schedule)
              .map(({ id, name }) => ({ id, name, active: true })),
          })),
      );
    }
    const match = /^\/v1\/agents\/([^/]+)\/(messages|routines\/([^/]+)\/run)$/.exec(path);
    if (!match?.[1] || !match[2] || request.method !== "POST") return new Response("", { status: 404 });
    const botId = decodeURIComponent(match[1]);
    const route = match[3] ? "run" : "messages";
    const agent = standInAgents.get(botId);
    if (!agent) return answer(botId, route, 404);
    if (!agent.allowed) return answer(botId, route, 403);
    const body = asRecord(await request.json());
    if (agent.hidden) return answer(botId, route, 409);
    if (route === "run") {
      const routineId = decodeURIComponent(match[3] ?? "");
      // `#run` returns 404 for a routine that `listRoutines` leaves out: a webhook routine.
      if (!agent.routines.some((routine) => routine.id === routineId && routine.schedule))
        return answer(botId, route, 404);
      if (agent.runsThisHour >= RUNS_PER_HOUR) return answer(botId, route, 429);
      agent.runsThisHour++;
      automationRuns.push({ botId, routineId, payload: isString(body?.payload) ? body.payload : "" });
      return answer(botId, route, 202, { runId: crypto.randomUUID(), deliveryId: crypto.randomUUID() });
    }
    const text = body?.text;
    const clientMessageId = body?.clientMessageId;
    if (
      !isString(text) ||
      !text ||
      text.length > MESSAGE_TEXT_LIMIT ||
      !isString(clientMessageId) ||
      !clientMessageId ||
      clientMessageId.length > IDENTIFIER_LIMIT
    )
      return answer(botId, route, 400);
    // The host takes the rate slot before it reads the idempotency key.
    if (agent.runsThisHour >= RUNS_PER_HOUR) return answer(botId, route, 429);
    agent.runsThisHour++;
    if (!automationMessages.some((entry) => entry.botId === botId && entry.clientMessageId === clientMessageId))
      automationMessages.push({ botId, clientMessageId, text });
    return answer(botId, route, 202, { deliveryId: `automation:${clientMessageId}` });
  },
});
writePrivate(join(automationRoot, "url"), `http://127.0.0.1:${automation.port}`);
writePrivate(join(automationRoot, "token"), automationToken);
function messagesFor(bot: Bot, deliveryId: string) {
  return automationMessages.filter((entry) => entry.botId === bot.botId && entry.text.includes(`(${deliveryId})`));
}
function messagePosts(bot: Bot): number {
  return automationAnswers.filter((entry) => entry.botId === bot.botId && entry.route === "messages").length;
}

// --- Files that the server keeps --------------------------------------------------------------
const staticConfigPath = join(temp, "static-config.json");
writeFileSync(
  staticConfigPath,
  JSON.stringify({
    version: 1,
    serverName: "e2e",
    relayOrigin: `http://127.0.0.1:${relay.port}`,
    wake: {
      ingressHosts: ["127.0.0.1"],
      stateDir,
      credentialsPath,
      automationRoot,
      reloadIntervalMs: 100,
      reconnectBaseMs: 50,
      retryBaseMs: 50,
      socketOpenTimeoutMs: 5000,
      heartbeatIntervalMs: 100,
      discoverAutomationRoutes: true,
    },
  }),
  { mode: 0o644 },
);
chmodSync(staticConfigPath, 0o644);
for (const bot of Object.values(bots))
  writePrivate(join(keysDir, `${bot.key.toUpperCase()}_INGRESS`), ingressKeys.get(bot.key));

function credential(bot: Bot) {
  return {
    agentId: bot.agentId,
    botId: bot.botId,
    botName: bot.key,
    hidden: false,
    profilePresent: true,
    relayName: bot.relayName,
    token: bot.token,
    verified: true,
  };
}
function writeCredentials(keys: BotKey[]): void {
  writePrivate(credentialsPath, {
    version: 1,
    serverId: "e2e",
    serverName: "e2e",
    bots: Object.fromEntries(keys.map((key) => [bots[key].botId, credential(bots[key])])),
  });
}
function hookdeckRoute(bot: Bot) {
  return {
    botId: bot.botId,
    relayName: bot.relayName,
    url: `http://127.0.0.1:${ingress.port}/src-${bot.key}`,
    ingressKeyPath: join(keysDir, `${bot.key.toUpperCase()}_INGRESS`),
    connectionId: `web_${bot.key}`,
  };
}
const routeC = { botId: bots.c.botId, relayName: bots.c.relayName, transport: "automation", routineId: "routine-c" };
const cutoverAt = new Date(Date.now() - 60_000).toISOString();
const configPath = join(stateDir, "config.json");
function writeRoutes(routes: unknown[]): void {
  writePrivate(configPath, { version: 1, cutoverAt, routes });
}

// E and H have no credential yet. D, F, G and K have one and no configured route: discovery finds them.
writeCredentials(["a", "b", "c", "d", "f", "g", "k"]);
writeRoutes([hookdeckRoute(bots.a), hookdeckRoute(bots.b), routeC, hookdeckRoute(bots.e)]);
// A row that waits in A's mailbox before the listener starts: the relay sends it only after register.
const startedAt = new Date().toISOString();
deliver(bots.a, "del_a0", startedAt);
// The relay refuses D's first registration, as it does while another instance holds the provider.
rejectNextRegister.set(bots.d.agentId, "provider_instance_conflict");

function readStatus(): DynamicRecord | null {
  return jsonRecord(() => readFileSync(join(stateDir, "status.json"), "utf8"));
}
/** One route's record in the status file. */
function statusRoute(bot: Bot): DynamicRecord | null {
  const routes = readStatus()?.routes;
  return asRecord(isDynamicRecord(routes) ? routes[bot.botId] : null);
}
function routeIs(bot: Bot, state: string): DynamicRecord | null {
  const route = statusRoute(bot);
  return route?.state === state ? route : null;
}
const stateWatcher = watch(stateDir, () => notify());

const env = {
  ...process.env,
  OPENBOT_AGENT_RELAY_CONFIG: staticConfigPath,
  OPENBOT_AGENT_RELAY_TEST_LOOPBACK: "1",
};
const nodeVersion = spawnSync(NODE, ["--version"], { encoding: "utf8" }).stdout.trim();
const listener = spawn(NODE, [join(HELPERS, "recipient-wake.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let listenerOutput = "";
listener.stdout.on("data", (chunk) => {
  listenerOutput += chunk;
});
listener.stderr.on("data", (chunk) => {
  listenerOutput += chunk;
});
let listenerExit: number | null = null;
listener.on("exit", (code) => {
  listenerExit = code ?? -1;
  notify();
});
function alive(): boolean {
  return listenerExit === null;
}

/** Runs the route tool without blocking this process, which also serves the automation stand-in. */
function runRouteTool(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(NODE, [join(HELPERS, "wake-routes.mjs"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function opens(bot: Bot): number {
  return relayOpens.get(bot.agentId) ?? 0;
}
function openList(keys: BotKey[]): string {
  return keys.map((key) => opens(bots[key])).join(",");
}

let failure: string | null = null;
try {
  const now = new Date().toISOString();

  // 1. Configured routes A, B, C (and E, which has no credential) and discovered routes D, F, G, K.
  await waitFor("A, B, C, D, F and K to connect", () =>
    (["a", "b", "c", "d", "f", "k"] as const).every((key) => relaySockets.has(bots[key].agentId)),
  );
  const waitingE = await waitFor("E to wait for its credential", () => routeIs(bots.e, "waiting_for_credential"));
  const waitingG = await waitFor("G to wait for local scripts", () => routeIs(bots.g, "waiting_for_local_scripts"));
  check(
    "routes_connect_and_wait",
    readStatus()?.routeCount === 8 && relaySockets.size === 6 && opens(bots.g) === 0,
    `routeCount=${readStatus()?.routeCount}, open sockets=${relaySockets.size}, E=${waitingE.state}, G=${waitingG.state}/${waitingG.error}, G socket opens=${opens(bots.g)}`,
  );

  // 1b. The row that waited before the listener started arrives after register, once.
  await waitFor("A's waiting row at the ingress", () => ingressCount(bots.a, "del_a0"));
  check(
    "pending_row_replayed_after_register",
    ingressCount(bots.a, "del_a0") === 1 && rowStatus(bots.a, "del_a0") === "delivered",
    `del_a0 count=${ingressCount(bots.a, "del_a0")}, relay row=${rowStatus(bots.a, "del_a0")}`,
  );

  // 1c. D's first registration was refused: the route records the code and registers again.
  const routeD = statusRoute(bots.d);
  check(
    "register_rejection_recorded",
    routeD?.lastErrorCode === "provider_instance_conflict" && opens(bots.d) >= 2 && relaySockets.has(bots.d.agentId),
    `D lastErrorCode=${routeD?.lastErrorCode}, D opens=${opens(bots.d)}, D state=${routeD?.state}`,
  );

  // 2. Hookdeck body bytes.
  deliver(bots.a, "del_a1", now);
  await waitFor("A delivery at the ingress", () => ingressCount(bots.a, "del_a1"));
  const bodyA = ingressBodies.find(
    (entry) => entry.key === "a" && asRecord(JSON.parse(entry.body))?.delivery_id === "del_a1",
  )?.body;
  check("hookdeck_body_bytes", bodyA === expectedBody(bots.a, "del_a1", now), `bytes=${bodyA?.length}`);

  // 3. A schedule routine runs; the stand-in refuses the webhook routine as the host does.
  deliver(bots.c, "del_c1", now);
  const runC = await waitFor("C routine run", () => automationRuns.find((run) => run.botId === bots.c.botId));
  check(
    "schedule_routine_run",
    runC.routineId === "routine-c" &&
      runC.payload === expectedBody(bots.c, "del_c1", now) &&
      !automationRefusals.length,
    `routine=${runC.routineId}, payloadMatches=${runC.payload === expectedBody(bots.c, "del_c1", now)}, refusals=${automationRefusals.length}`,
  );

  // 4. A message wake goes out once per delivery, with no relay content. A reconnect replays del_f1.
  deliver(bots.f, "del_f1", now);
  await waitFor("F first message", () => messagesFor(bots.f, "del_f1").length);
  const opensF = opens(bots.f);
  relaySockets.get(bots.f.agentId)?.terminate();
  await waitFor("F to register again", () => opens(bots.f) > opensF && relaySockets.has(bots.f.agentId));
  deliver(bots.f, "del_f2", now);
  await waitFor("F second message", () => messagesFor(bots.f, "del_f2").length);
  const messageF = messagesFor(bots.f, "del_f1");
  const textF = messageF[0]?.text ?? "";
  check(
    "message_wake_once_per_delivery",
    messageF.length === 1 &&
      messagePosts(bots.f) === 2 &&
      !textF.includes(RELAY_CONTENT) &&
      textF.includes(bots.f.botId) &&
      (messageF[0]?.clientMessageId.length ?? 999) <= IDENTIFIER_LIMIT &&
      routeIs(bots.f, "connected") !== null,
    `del_f1 messages=${messageF.length}, posts=${messagePosts(bots.f)}, text chars=${textF.length}, relay content=${textF.includes(RELAY_CONTENT)}, id chars=${messageF[0]?.clientMessageId.length}`,
  );

  // 5. A reconnect replays every unacknowledged row; each goes out once. The next delivery on the
  // new socket proves that the replay was handled.
  const opensABefore = opens(bots.a);
  relaySockets.get(bots.a.agentId)?.terminate();
  await waitFor("A to register again", () => opens(bots.a) > opensABefore && relaySockets.has(bots.a.agentId));
  const opensA = opens(bots.a);
  deliver(bots.a, "del_a2", now);
  await waitFor("A second delivery", () => ingressCount(bots.a, "del_a2"));
  // The listener writes its ledger after the target accepts, so wait for the entry.
  const ledger = await waitFor("the ledger entry of del_a2", () => {
    const value = jsonRecord(() => readFileSync(join(stateDir, "accepted.json"), "utf8"));
    return value?.[`${bots.a.botId}:del_a2`] ? value : null;
  });
  check(
    "duplicate_forwarded_once",
    ingressCount(bots.a, "del_a0") === 1 &&
      ingressCount(bots.a, "del_a1") === 1 &&
      Boolean(ledger[`${bots.a.botId}:del_a1`]) &&
      rowStatus(bots.a, "del_a1") === "delivered",
    `after replay: del_a0 count=${ingressCount(bots.a, "del_a0")}, del_a1 count=${ingressCount(bots.a, "del_a1")}, relay row=${rowStatus(bots.a, "del_a1")}, ledger entries=${Object.keys(ledger).length}`,
  );

  // 6. B's socket drops and its next two upgrades are refused. The process and A keep working.
  failNextUpgrades.set(bots.b.agentId, 2);
  relaySockets.get(bots.b.agentId)?.terminate();
  await waitFor("two refused upgrades for B", () => (failedUpgrades.get(bots.b.agentId) ?? 0) >= 2);
  const aliveAfterErrors = alive();
  deliver(bots.a, "del_a3", now);
  await waitFor("A delivery while B fails", () => ingressCount(bots.a, "del_a3"));
  await waitFor("B to connect again", () => opens(bots.b) >= 2 && relaySockets.has(bots.b.agentId));
  deliver(bots.b, "del_b1", now);
  await waitFor("B delivery after its errors", () => ingressCount(bots.b, "del_b1"));
  check(
    "socket_error_isolated",
    aliveAfterErrors && alive() && opens(bots.a) === opensA,
    `refused upgrades=${failedUpgrades.get(bots.b.agentId)}, process alive=${alive()}, A opens=${opens(bots.a)}, B opens=${opens(bots.b)}`,
  );

  // 7. Local scripts turned off for K: 403 waits and other routes deliver; turned on, K delivers.
  standIn(bots.k).allowed = false;
  deliver(bots.k, "del_k1", now);
  await waitFor("K 403", () => answers(bots.k, 403));
  await waitFor("K to wait for local scripts", () => routeIs(bots.k, "waiting_for_local_scripts"));
  deliver(bots.a, "del_a4", now);
  deliver(bots.f, "del_f3", now);
  await waitFor(
    "A and F deliveries while K waits",
    () => ingressCount(bots.a, "del_a4") && messagesFor(bots.f, "del_f3").length,
  );
  const kLedgeredWhileRefused = Boolean(
    jsonRecord(() => readFileSync(join(stateDir, "accepted.json"), "utf8"))?.[`${bots.k.botId}:del_k1`],
  );
  standIn(bots.k).allowed = true;
  await waitFor("K message after local scripts on", () => messagesFor(bots.k, "del_k1").length);
  await waitFor("K connected again", () => routeIs(bots.k, "connected"));
  check(
    "local_scripts_off_waits_then_recovers",
    !kLedgeredWhileRefused && alive() && opens(bots.k) === 1,
    `403 answers=${answers(bots.k, 403)}, ledgered while refused=${kLedgeredWhileRefused}, K opens=${opens(bots.k)}`,
  );

  // 8. G is not listed, so it holds no socket; when the owner turns local scripts on, it connects.
  standIn(bots.g).allowed = true;
  await waitFor("G to connect", () => relaySockets.has(bots.g.agentId));
  deliver(bots.g, "del_g1", now);
  await waitFor("G message", () => messagesFor(bots.g, "del_g1").length);
  check("unlisted_route_connects_when_turned_on", opens(bots.g) === 1, `G opens=${opens(bots.g)}`);

  // 9. A hidden agent gets 409 and waits; other routes deliver; restored, it delivers.
  standIn(bots.k).hidden = true;
  deliver(bots.k, "del_k2", now);
  await waitFor("K to wait as hidden", () => routeIs(bots.k, "agent_hidden"));
  deliver(bots.a, "del_a5", now);
  await waitFor("A delivery while K is hidden", () => ingressCount(bots.a, "del_a5"));
  standIn(bots.k).hidden = false;
  await waitFor("K message after restore", () => messagesFor(bots.k, "del_k2").length);
  check(
    "hidden_agent_waits_then_recovers",
    answers(bots.k, 409) >= 1 && alive(),
    `409 answers=${answers(bots.k, 409)}`,
  );

  // 10. F reaches its hourly limit: 429 retries with backoff and delivers when slots are free.
  standIn(bots.f).runsThisHour = RUNS_PER_HOUR;
  deliver(bots.f, "del_f4", now);
  await waitFor("F 429", () => answers(bots.f, 429));
  standIn(bots.f).runsThisHour = 0;
  await waitFor("F message after the limit", () => messagesFor(bots.f, "del_f4").length);
  check(
    "rate_limited_then_delivers",
    messagesFor(bots.f, "del_f4").length === 1,
    `429 answers=${answers(bots.f, 429)}`,
  );

  // 11. A configured route replaces D's discovered route without a restart; other sockets stay.
  const pidBefore = readStatus()?.pid;
  const opensBefore = openList(["a", "b", "c", "f", "g", "k"]);
  const opensD = opens(bots.d);
  writeRoutes([hookdeckRoute(bots.a), hookdeckRoute(bots.b), routeC, hookdeckRoute(bots.e), hookdeckRoute(bots.d)]);
  await waitFor(
    "D to reconnect as a Hookdeck route",
    () =>
      statusRoute(bots.d)?.wake === "hookdeck" &&
      statusRoute(bots.d)?.state === "connected" &&
      opens(bots.d) === opensD + 1 &&
      relaySockets.has(bots.d.agentId),
  );
  deliver(bots.d, "del_d1", now);
  await waitFor("D delivery at the ingress", () => ingressCount(bots.d, "del_d1"));
  check(
    "configured_route_wins_without_restart",
    readStatus()?.pid === pidBefore &&
      listener.pid === pidBefore &&
      openList(["a", "b", "c", "f", "g", "k"]) === opensBefore &&
      messagesFor(bots.d, "del_d1").length === 0,
    `pid unchanged=${readStatus()?.pid === pidBefore}, opens before=${opensBefore} after=${openList(["a", "b", "c", "f", "g", "k"])}`,
  );

  // 12. E's credential appears; E connects. H gets a credential and a discovered route.
  writeCredentials(["a", "b", "c", "d", "e", "f", "g", "h", "k"]);
  await waitFor("E to connect", () => relaySockets.has(bots.e.agentId));
  deliver(bots.e, "del_e1", now);
  await waitFor("E delivery", () => ingressCount(bots.e, "del_e1"));
  check(
    "credential_wait_then_connect",
    routeIs(bots.e, "connected") !== null,
    "E delivered after its credential appeared",
  );
  await waitFor("H to connect", () => relaySockets.has(bots.h.agentId));
  deliver(bots.h, "del_h1", now);
  await waitFor("H message", () => messagesFor(bots.h, "del_h1").length);
  check(
    "discovered_route_for_new_credential",
    statusRoute(bots.h)?.wake === "message" &&
      statusRoute(bots.h)?.discovered === true &&
      readStatus()?.pid === pidBefore,
    `H wake=${statusRoute(bots.h)?.wake}, discovered=${statusRoute(bots.h)?.discovered}`,
  );

  // 13. The route tool: a dry run changes nothing; --apply writes F, G, H and K, and no socket reopens.
  const configBefore = readFileSync(configPath, "utf8");
  const dry = await runRouteTool([]);
  if (dry.status !== 0) throw new Error(`The route tool failed: ${dry.stderr.slice(-2000)}`);
  const plan = jsonRecord(() => dry.stdout);
  const add = records(plan?.add);
  const dryUnchanged = readFileSync(configPath, "utf8") === configBefore;
  const opensBeforeApply = openList(["a", "b", "c", "d", "e", "f", "g", "h", "k"]);
  const applied = await runRouteTool(["--apply"]);
  const loadedAfterApply = readStatus()?.configLoadedAt;
  // Two reloads after the write: the first can start before the file changed.
  const firstReload = await waitFor("a reload after the apply", () => {
    const value = readStatus()?.configLoadedAt;
    return value !== loadedAfterApply ? value : null;
  });
  await waitFor("a second reload after the apply", () => readStatus()?.configLoadedAt !== firstReload);
  const addedKeys = add.map((entry) => Object.values(bots).find((bot) => bot.botId === entry.botId)?.key).sort();
  check(
    "route_tool_dry_run_and_apply",
    dry.status === 0 &&
      applied.status === 0 &&
      dryUnchanged &&
      addedKeys.join(",") === "f,g,h,k" &&
      add.every((entry) => entry.localScripts === "on") &&
      openList(["a", "b", "c", "d", "e", "f", "g", "h", "k"]) === opensBeforeApply &&
      readStatus()?.routeCount === 9,
    `dry run unchanged=${dryUnchanged}, add=${addedKeys.join(",")}, opens unchanged=${openList(["a", "b", "c", "d", "e", "f", "g", "h", "k"]) === opensBeforeApply}, routeCount=${readStatus()?.routeCount}`,
  );

  // 13b. The wire: valid register and heartbeat frames, no confirmation frame, and status counters
  // that show what each route received.
  const routeA = statusRoute(bots.a);
  const framesA = asRecord(routeA?.frames);
  const sentTypes = [...new Set(listenerFrames.map((entry) => entry.type))].sort();
  const unexpected = refusedFrames.filter(
    (entry) => !(entry.agentId === bots.d.agentId && entry.reason === "provider_instance_conflict"),
  );
  const registeredAgents = (["a", "b", "c", "d", "e", "f", "g", "h", "k"] as const).map((key) => bots[key].agentId);
  check(
    "relay_protocol_and_counters",
    unexpected.length === 0 &&
      sentTypes.join(",") === "node.heartbeat,node.register" &&
      registeredAgents.every((agentId) => (heartbeatsIn.get(agentId) ?? 0) > 0) &&
      Number(framesA?.deliver) >= 1 &&
      Number(framesA?.reply) >= 1 &&
      Number(framesA?.ping) >= 1 &&
      isString(routeA?.lastFrameAt) &&
      isString(routeA?.lastHeartbeatReplyAt),
    `listener sent=${sentTypes.join(",")}, refused=${unexpected.length}, A frames=${JSON.stringify(framesA)}, heartbeats from all routes=${registeredAgents.every((agentId) => (heartbeatsIn.get(agentId) ?? 0) > 0)}`,
  );

  // 14. No secret in the status file.
  const statusText = readFileSync(join(stateDir, "status.json"), "utf8");
  const secrets = [...Object.values(bots).map((bot) => bot.token), ...ingressKeys.values(), automationToken];
  check(
    "status_has_no_secret",
    !secrets.some((secret) => statusText.includes(secret)) && !statusText.includes(RELAY_CONTENT),
    `checked ${secrets.length} values and the relay content`,
  );

  // 15. SIGTERM ends the process cleanly and removes the lock.
  listener.kill("SIGTERM");
  await waitFor("listener exit", () => listenerExit !== null);
  check(
    "clean_stop",
    listenerExit === 0 && !existsSync(join(stateDir, "listener.lock")),
    `exit=${listenerExit}, lock removed=${!existsSync(join(stateDir, "listener.lock"))}`,
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  check("run_completed", false, failure);
} finally {
  if (alive()) listener.kill("SIGKILL");
  stateWatcher.close();
  relay.stop(true);
  ingress.stop(true);
  automation.stop(true);
}

const passed = checks.every((entry) => entry.pass);
mkdirSync(REPORT_DIRECTORY, { recursive: true });
const reportPath = join(REPORT_DIRECTORY, "report.json");
writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: nodeVersion,
      listener: "scripts/hosting/agent-relay/recipient-wake.mjs",
      passed,
      checks,
      // Only on failure: the listener prints fixed labels, and this run's values are not secrets.
      listenerOutput: passed ? undefined : listenerOutput.slice(-4000),
      status: passed ? undefined : readStatus(),
    },
    null,
    2,
  )}\n`,
);
rmSync(temp, { recursive: true, force: true });
logger.info(`${passed ? "PASSED" : "FAILED"}: ${reportPath}`);
process.exit(passed ? 0 : 1);
