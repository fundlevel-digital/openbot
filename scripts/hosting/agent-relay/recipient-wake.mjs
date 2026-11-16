// Wakes an OpenBot agent when its Agent Relay inbox receives a delivery.
//
// For each route, the listener opens the agent's direct node socket (`/v1/node/ws` with the token of
// `POST /v1/agent/node-token`) and sends `node.register`. Only after the relay's `reply` does it attach
// the socket as the agent's delivery provider and push `deliver` frames: first every unacknowledged
// row that has not expired, then new ones. A `node.heartbeat` with an `id` goes out every
// `heartbeatIntervalMs`; the relay marks a node offline after 45 s without one. For each delivery
// after the cutover time, the listener sends a wake to the route's target.
//
// It never sends relay message text to OpenBot, never sends a relay message, and never sends
// `delivery.accepted` or `delivery.ack`: the agent reads its own inbox and acknowledges there. The
// socket write already moves the row from `queued` to `delivered`, which stops the relay's retry; the
// row stays in the agent's inbox (`GET /v1/deliveries` lists `queued` and `delivered`) until the
// agent acknowledges it or it expires, and each reconnect replays it, which the ledger absorbs.
//
// Wake targets:
// - `hookdeck` (the default, for routes with no `transport`): POST the metadata JSON to an
//   authenticated Hookdeck source, which signs it and forwards it to the agent's webhook routine.
// - `message`: send the agent a fixed chat message through OpenBot's loopback automation server
//   (`POST /v1/agents/:id/messages`). It needs only "Local scripts" on and a visible agent: no
//   routine, webhook slot, secret or Hookdeck.
// - `automation`: run one of the agent's routines through the same server. The server lists and
//   runs only routines with a schedule trigger; a webhook routine gets 404.
//
// Static deployment values come from `/etc/openbot-agent-relay/config.json`, or from the file that
// `OPENBOT_AGENT_RELAY_CONFIG` names. The route list is `<stateDir>/config.json`; the listener reads
// it again at each reload interval. A new route connects, a removed route stops, and an unchanged
// route keeps its socket. With `wake.discoverAutomationRoutes`, every agent with a verified relay
// credential and no configured route also gets a `message` route; a configured route always wins.
//
// A route waits, without failing the others, in these states: `waiting_for_credential` (no verified
// relay credential), `waiting_for_local_scripts` (the automation server does not show the agent:
// "Local scripts" is off, or, on a host before v0.71.0, the agent is hidden) and `agent_hidden` (a
// host before v0.71.0 refused a hidden agent with 409; from v0.71.0 a hidden agent takes work and is
// woken). It checks again at each reload interval. A delivery goes into the ledger only after the
// target accepted it.
//
// Only an explicit test run can use plain HTTP: `OPENBOT_AGENT_RELAY_TEST_LOOPBACK=1` permits
// `http:` and `ws:` origins and ingress targets on 127.0.0.1. Production origins must be HTTPS.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATIC_CONFIG_PATH = "/etc/openbot-agent-relay/config.json";
const STATIC_CONFIG_ENV = "OPENBOT_AGENT_RELAY_CONFIG";
/** The same test flag as `relay-config.py`. systemd units never set it. */
const TEST_LOOPBACK_ENV = "OPENBOT_AGENT_RELAY_TEST_LOOPBACK";
const STATE_ROOT = "/var/lib/openbot/.local/state/openbot-agent-relay";
const DEFAULT_MESSAGE_TEMPLATE = [
  "Agent Relay wake-up: a new delivery ({deliveryId}) is in the Agent Relay inbox of {relayName}.",
  "This message has no relay content. Handle each delivery as your Agent Relay instructions say.",
  "1. Read your inbox: python3 /opt/openbot-agent-relay/relay-messaging.py --bot {botId} inbox",
  "2. Act on each delivery under your normal rules and the owner's approvals.",
  "3. After you record a delivery, acknowledge it: python3 /opt/openbot-agent-relay/relay-messaging.py --bot {botId} ack --delivery <delivery-id>",
  "Leave a delivery that you could not process unacknowledged.",
  "The relay removes an unacknowledged delivery from the inbox one hour after it was sent. If {deliveryId} is not in your inbox, it was acknowledged or it expired; do not guess its content.",
].join("\n");
const DEFAULTS = {
  relayOrigin: "https://cast.agentrelay.com",
  stateDir: `${STATE_ROOT}/wake`,
  credentialsPath: `${STATE_ROOT}/messaging-credentials.json`,
  automationRoot: "/var/lib/openbot/.config/OpenBot/automation",
  ingressHosts: ["hkdk.events"],
  reloadIntervalMs: 5000,
  reconnectBaseMs: 2000,
  retryBaseMs: 1000,
  socketOpenTimeoutMs: 20000,
  heartbeatIntervalMs: 15000,
  discoverAutomationRoutes: false,
  messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
};
const USER_AGENT = "openbot-recipient-wake/1";
/** The `version` of `node.register`. */
const NODE_VERSION = "openbot-recipient-wake/2";
const REQUEST_TIMEOUT_MS = 20000;
/** The relay marks a node offline after 45 s with no heartbeat (`NODE_LIVENESS_TTL_MS`). */
const HEARTBEAT_LIMIT_MS = 40000;
const FRAME_TYPE = /^[a-z][a-z0-9_.]{0,63}$/;
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_FRAME_CHARS = 1_000_000;
const MAX_BACKOFF_MS = 60000;
/** `INPUT_LIMITS.identifier` in packages/contracts/src/input-limits.ts. */
const AUTOMATION_IDENTIFIER_LIMIT = 128;
/** `INPUT_LIMITS.messageText`. The template has its own lower bound. */
const MESSAGE_TEXT_LIMIT = 100_000;
const MESSAGE_TEMPLATE_LIMIT = 8000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
/** A delivery ID that is safe to put in a chat message. Others are refused for `message` routes. */
const MESSAGE_DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** The same rule as `relay-config.py`. */
const SERVER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AUTOMATION_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const AUTOMATION_TRANSPORTS = new Set(["message", "automation"]);
const allowed = new Set(["dm.received", "group_dm.received", "message.created", "thread.reply"]);
/** States in which the agent has no usable credential yet. They are not failures. */
const CREDENTIAL_PENDING = new Set(["credentials_missing", "credential_missing", "credential_unverified"]);
/** Error labels that are safe to show as they are. Others become a generic label. */
const SAFE_ERROR =
  /^(identity_|node_|profile_|server_|private_|ingress_|automation_|routine_|relay_|socket_|missing_)[a-z0-9_]*$/;

/** A refusal that only the owner can end. The route waits in `state` and checks again at the reload interval. */
class WakeRefused extends Error {
  constructor(state, label) {
    super(label);
    this.state = state;
  }
}

export function projectFrame(frame, bot, cutoff) {
  if (frame?.type !== "deliver") return null;
  if (frame.agent_id !== bot.agentId || frame.agent !== bot.relayName) throw new Error("recipient_mismatch");
  if (typeof frame.delivery_id !== "string" || !frame.delivery_id || typeof frame.msg_id !== "string" || !frame.msg_id)
    throw new Error("invalid_delivery");
  if (!allowed.has(frame.payload?.type)) return null;
  const data = frame.payload.data;
  const created = data?.created_at || data?.message?.created_at;
  if (!created || !Number.isFinite(Date.parse(created))) throw new Error("missing_created_at");
  if (Date.parse(created) < Date.parse(cutoff)) return null;
  // The key order is the released wire shape: Hookdeck filters and the routines read these bytes.
  return {
    event_type: "agent-relay.message",
    delivery_id: frame.delivery_id,
    message_id: frame.msg_id,
    recipient_agent_id: bot.agentId,
    recipient_bot_id: bot.botId,
    created_at: created,
  };
}

/** Reads a file only when this user owns it and no other user can read or write it. */
export function readPrivate(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077)
    throw new Error("private_file_permissions");
  return fs.readFileSync(file, "utf8");
}

export function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** A bare origin. HTTPS or WSS only, except a 127.0.0.1 origin in an explicit test run. */
function secureOrigin(value, secure, loopback) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("static_config_origin_invalid");
  const insecure = secure === "https:" ? "http:" : "ws:";
  if (url.protocol === secure) return url.origin;
  if (loopback && url.protocol === insecure && url.hostname === "127.0.0.1") return url.origin;
  throw new Error("static_config_origin_refused");
}

function absolutePath(value, fallback) {
  const result = value ?? fallback;
  if (typeof result !== "string" || !path.isAbsolute(result)) throw new Error("static_config_path_invalid");
  return result;
}

function boundedInteger(value, fallback, min, max) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error("static_config_number_invalid");
  return result;
}

/**
 * The deployment values. A missing or unsafe file stops the listener before it connects. Root must
 * own the file and its folder, and no other user may write them; a test run may also own them.
 */
export function loadStaticConfig(env = process.env) {
  const file = env[STATIC_CONFIG_ENV] || STATIC_CONFIG_PATH;
  const loopback = env[TEST_LOOPBACK_ENV] === "1";
  const owners = loopback ? new Set([0, process.getuid()]) : new Set([0]);
  for (const item of [file, path.dirname(file)]) {
    const st = fs.lstatSync(item);
    if (st.isSymbolicLink() || !owners.has(st.uid) || st.mode & 0o022) throw new Error("static_config_permissions");
  }
  if (!fs.lstatSync(file).isFile()) throw new Error("static_config_permissions");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw?.version !== 1) throw new Error("static_config_version");
  const wake = raw.wake ?? {};
  if (typeof raw.serverName !== "string" || raw.serverName.length > 30 || !SERVER_NAME.test(raw.serverName))
    throw new Error("static_config_server_name");
  const relayOrigin = secureOrigin(raw.relayOrigin ?? DEFAULTS.relayOrigin, "https:", loopback);
  const relayWebSocketOrigin = secureOrigin(
    wake.relayWebSocketOrigin ?? relayOrigin.replace(/^http/, "ws"),
    "wss:",
    loopback,
  );
  const ingressHosts = wake.ingressHosts ?? DEFAULTS.ingressHosts;
  if (!Array.isArray(ingressHosts) || !ingressHosts.every((host) => typeof host === "string" && host))
    throw new Error("static_config_ingress_hosts");
  if (typeof (wake.discoverAutomationRoutes ?? false) !== "boolean") throw new Error("static_config_discovery");
  const messageTemplate = wake.messageTemplate ?? DEFAULTS.messageTemplate;
  if (
    typeof messageTemplate !== "string" ||
    !messageTemplate.includes("{deliveryId}") ||
    messageTemplate.length > MESSAGE_TEMPLATE_LIMIT
  )
    throw new Error("static_config_message_template");
  return {
    serverName: raw.serverName,
    relayOrigin,
    relayWebSocketOrigin,
    loopback,
    ingressHosts: new Set(ingressHosts),
    stateDir: absolutePath(wake.stateDir, DEFAULTS.stateDir),
    credentialsPath: absolutePath(wake.credentialsPath, DEFAULTS.credentialsPath),
    automationRoot: absolutePath(wake.automationRoot, DEFAULTS.automationRoot),
    reloadIntervalMs: boundedInteger(wake.reloadIntervalMs, DEFAULTS.reloadIntervalMs, 50, 600000),
    reconnectBaseMs: boundedInteger(wake.reconnectBaseMs, DEFAULTS.reconnectBaseMs, 10, 60000),
    retryBaseMs: boundedInteger(wake.retryBaseMs, DEFAULTS.retryBaseMs, 10, 60000),
    socketOpenTimeoutMs: boundedInteger(wake.socketOpenTimeoutMs, DEFAULTS.socketOpenTimeoutMs, 100, 120000),
    heartbeatIntervalMs: boundedInteger(wake.heartbeatIntervalMs, DEFAULTS.heartbeatIntervalMs, 50, HEARTBEAT_LIMIT_MS),
    discoverAutomationRoutes: wake.discoverAutomationRoutes ?? DEFAULTS.discoverAutomationRoutes,
    messageTemplate,
  };
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`invalid_route_${label}`);
  return value;
}

/** Validates the private route file. A file with one bad route is refused as a whole. */
export function parseRoutes(config) {
  if (config?.version !== 1 || !Array.isArray(config.routes) || !Number.isFinite(Date.parse(config.cutoverAt)))
    throw new Error("invalid_config");
  const seen = new Set();
  const routes = config.routes.map((route) => {
    const transport = route.transport ?? "hookdeck";
    const base = {
      botId: identifier(route.botId, "bot"),
      relayName: identifier(route.relayName, "relay_name"),
      transport,
    };
    if (route.cutoverAt !== undefined) {
      if (!Number.isFinite(Date.parse(route.cutoverAt))) throw new Error("invalid_route_cutover");
      base.cutoverAt = route.cutoverAt;
    }
    if (transport === "hookdeck") {
      if (
        typeof route.url !== "string" ||
        typeof route.ingressKeyPath !== "string" ||
        !path.isAbsolute(route.ingressKeyPath)
      )
        throw new Error("invalid_route_hookdeck");
      Object.assign(base, { url: route.url, ingressKeyPath: route.ingressKeyPath });
      if (route.connectionId !== undefined) base.connectionId = identifier(route.connectionId, "connection");
    } else if (transport === "automation") {
      base.routineId = identifier(route.routineId, "routine");
    } else if (transport !== "message") throw new Error("invalid_route_transport");
    if (seen.has(base.botId)) throw new Error("duplicate_recipient");
    seen.add(base.botId);
    return base;
  });
  return { cutoverAt: config.cutoverAt, routes };
}

function readCredentials(settings) {
  if (!fs.existsSync(settings.credentialsPath)) throw new Error("credentials_missing");
  const saved = JSON.parse(readPrivate(settings.credentialsPath));
  if (saved.serverName !== settings.serverName) throw new Error("server_mismatch");
  return saved;
}

/** The verified credential of one route's agent, or a `credential_*` error while it has none. */
export function selectBot(route, settings) {
  const bot = readCredentials(settings).bots?.[route.botId];
  if (!bot) throw new Error("credential_missing");
  if (!bot.profilePresent || !bot.verified || typeof bot.token !== "string" || !bot.token || !bot.agentId)
    throw new Error("credential_unverified");
  if (bot.relayName !== route.relayName || bot.botId !== route.botId) throw new Error("profile_mismatch");
  return bot;
}

/**
 * A `message` route for each agent with a verified relay credential and no configured route. It
 * does not need the automation server: a route for an agent that the server does not show waits.
 */
export function discoverMessageRoutes(settings, configuredBotIds) {
  const routes = [];
  const skipped = [];
  for (const [botId, bot] of Object.entries(readCredentials(settings).bots ?? {})) {
    if (configuredBotIds.has(botId)) continue;
    if (!bot.profilePresent || !bot.verified || !IDENTIFIER.test(botId) || !IDENTIFIER.test(bot.relayName ?? "")) {
      skipped.push({ botId, relayName: bot.relayName ?? null, reason: "credential_unverified" });
      continue;
    }
    routes.push({ botId, relayName: bot.relayName, transport: "message" });
  }
  return { routes, skipped };
}

async function relayApi(settings, bot, endpoint, method = "GET") {
  const response = await fetch(settings.relayOrigin + endpoint, {
    method,
    headers: { authorization: `Bearer ${bot.token}`, "user-agent": USER_AGENT },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`relay_http_${response.status}`);
  const body = await response.json();
  if (!body.ok || !body.data) throw new Error("relay_response_invalid");
  return body.data;
}

export async function forwardMetadata(metadata, route, post, ledger, persist) {
  const body = JSON.stringify(metadata);
  const key = `${route.botId}:${metadata.delivery_id}`;
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  if (ledger[key]) {
    if (ledger[key] !== digest) throw new Error("delivery_identity_conflict");
    return false;
  }
  await post(body, metadata);
  ledger[key] = digest;
  try {
    persist();
  } catch (error) {
    delete ledger[key];
    throw error;
  }
  return true;
}

/** The checked Hookdeck target of a route. The host must be on the allow-list. */
function hookdeckTarget(route, settings) {
  const target = new URL(route.url);
  const secure = target.protocol === "https:";
  const testLoopback = settings.loopback && target.protocol === "http:" && target.hostname === "127.0.0.1";
  if (
    !(secure || testLoopback) ||
    !settings.ingressHosts.has(target.hostname) ||
    target.username ||
    target.password ||
    target.search
  )
    throw new Error("ingress_refused");
  return target;
}

/** The loopback automation server's URL and token. Both change when OpenBot starts again. */
function automationEndpoint(settings) {
  const base = readPrivate(path.join(settings.automationRoot, "url")).trim();
  if (!AUTOMATION_URL.test(base)) throw new Error("automation_url_invalid");
  const token = readPrivate(path.join(settings.automationRoot, "token")).trim();
  if (!token) throw new Error("automation_token_missing");
  return { base, token };
}

async function automationRequest(settings, pathname, init = {}) {
  let endpoint;
  try {
    endpoint = automationEndpoint(settings);
  } catch (error) {
    // OpenBot removes the files when it stops and while no agent allows local scripts.
    throw error.code === "ENOENT" ? new Error("automation_unavailable") : error;
  }
  return fetch(endpoint.base + pathname, {
    ...init,
    headers: { authorization: `Bearer ${endpoint.token}`, "user-agent": USER_AGENT, ...init.headers },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * The agent IDs that the automation server shows: "Local scripts" is on. A host before v0.71.0 also
 * leaves out a hidden agent; from v0.71.0 the server lists it.
 * Null when the server does not answer; the caller then keeps what it knew before.
 */
export async function automationAgents(settings) {
  try {
    const response = await automationRequest(settings, "/v1/agents");
    if (!response.ok) {
      await response.body?.cancel();
      return response.status === 401 || response.status >= 500 ? null : new Set();
    }
    const agents = await response.json();
    return new Set(
      Array.isArray(agents) ? agents.map((agent) => agent?.id).filter((id) => typeof id === "string") : [],
    );
  } catch (error) {
    // No files means no agent allows local scripts, or OpenBot is not running.
    return error.message === "automation_unavailable" ? new Set() : null;
  }
}

/** Maps an automation server answer. 202 is the only success. */
function automationOutcome(status, transport) {
  if (status === 202) return;
  if (status === 403) throw new WakeRefused("waiting_for_local_scripts", "automation_local_scripts_off");
  // A host before v0.71.0 answers 409 for a hidden agent. From v0.71.0 a hidden agent takes work.
  if (status === 409 && transport === "message") throw new WakeRefused("agent_hidden", "automation_agent_hidden");
  if (status === 404)
    throw new WakeRefused(
      transport === "message" ? "waiting_for_local_scripts" : "routine_not_runnable",
      "automation_http_404",
    );
  // 401 (a new token after a restart), 409 for a busy routine, 429 and 5xx: retry with backoff.
  throw new Error(`automation_http_${status}`);
}

/** A stable `clientMessageId` for one delivery. The host keeps it for a day and does not send twice. */
export function wakeMessageId(botId, deliveryId) {
  const id = `relay-wake-${crypto.createHash("sha256").update(`${botId}\n${deliveryId}`).digest("hex")}`;
  if (id.length > AUTOMATION_IDENTIFIER_LIMIT) throw new Error("automation_message_id_too_long");
  return id;
}

/** The wake text. It has only the delivery ID and route names, never relay message content. */
export function wakeMessageText(template, route, deliveryId) {
  if (!MESSAGE_DELIVERY_ID.test(deliveryId)) throw new Error("delivery_identity_unsafe");
  const text = template
    .replaceAll("{deliveryId}", deliveryId)
    .replaceAll("{botId}", route.botId)
    .replaceAll("{relayName}", route.relayName);
  if (text.length > MESSAGE_TEXT_LIMIT) throw new Error("automation_message_too_long");
  return text;
}

/** The function that sends one wake to the route's target. */
function wakeSender(route, settings) {
  if (route.transport === "message") {
    const pathname = `/v1/agents/${encodeURIComponent(route.botId)}/messages`;
    return async (_body, metadata) => {
      const response = await automationRequest(settings, pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: wakeMessageText(settings.messageTemplate, route, metadata.delivery_id),
          clientMessageId: wakeMessageId(route.botId, metadata.delivery_id),
        }),
      });
      await response.body?.cancel();
      automationOutcome(response.status, "message");
    };
  }
  if (route.transport === "automation") {
    const pathname = `/v1/agents/${encodeURIComponent(route.botId)}/routines/${encodeURIComponent(route.routineId)}/run`;
    return async (body) => {
      const response = await automationRequest(settings, pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: body }),
      });
      await response.body?.cancel();
      automationOutcome(response.status, "automation");
    };
  }
  const target = hookdeckTarget(route, settings);
  const ingressKey = readPrivate(route.ingressKeyPath).trim();
  if (!ingressKey) throw new Error("missing_ingress_key");
  return async (body) => {
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": ingressKey, "user-agent": USER_AGENT },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`ingress_http_${response.status}`);
    await response.body?.cancel();
  };
}

/** A relay error code that is safe to keep in the status file. */
function safeCode(value) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : "unknown";
}

function errorLabel(error) {
  const message = error instanceof Error ? error.message : "";
  return SAFE_ERROR.test(message) ? message : "connection_unavailable";
}

function backoff(base, attempt) {
  return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(attempt, 6));
}

/** Resolves after `ms`, or at once when the signal aborts. Never rejects. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Closes a socket and ignores the error that a socket in a closing state can throw. */
function closeQuietly(ws) {
  try {
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
  } catch {
    // The socket is already closing.
  }
}

function acquireLock(stateDir) {
  const lock = path.join(stateDir, "listener.lock");
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch {
    const pid = Number(readPrivate(path.join(lock, "pid")));
    try {
      process.kill(pid, 0);
      throw new Error("listener_already_running");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    fs.unlinkSync(path.join(lock, "pid"));
    fs.rmdirSync(lock);
    fs.mkdirSync(lock, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  return () => {
    fs.unlinkSync(path.join(lock, "pid"));
    fs.rmdirSync(lock);
  };
}

async function main() {
  const settings = loadStaticConfig();
  fs.mkdirSync(settings.stateDir, { recursive: true, mode: 0o700 });
  const releaseLock = acquireLock(settings.stateDir);
  const configPath = path.join(settings.stateDir, "config.json");
  const ledgerPath = path.join(settings.stateDir, "accepted.json");
  const ledger = fs.existsSync(ledgerPath) ? JSON.parse(readPrivate(ledgerPath)) : {};
  const status = {
    startedAt: new Date().toISOString(),
    pid: process.pid,
    transport: "recipient-scoped-websocket",
    acksSent: 0,
    messagesSent: 0,
    routes: {},
  };
  const writeStatus = () => {
    try {
      atomicWrite(path.join(settings.stateDir, "status.json"), status);
    } catch {
      // A full disk must not stop delivery. The next change writes the status again.
    }
  };
  /** botId -> { key, controller, done } for the routes in the current route list. */
  const running = new Map();
  /** botId -> the promise of that agent's latest route loop, also after the route stops. */
  const loops = new Map();
  /** The agents that the automation server showed at the last reload; null until it answers. */
  let exposed = null;
  /** The `message` routes that discovery found at the last successful read of the credentials. */
  let discovered = [];
  /** Makes each connection's `node.register` and heartbeat request IDs unique. */
  let connectionCount = 0;
  let stopping = false;
  const stopController = new AbortController();

  const runRoute = async (route, cutoverAt, signal) => {
    const previous = status.routes[route.botId];
    const record = {
      name: route.relayName,
      wake: route.transport,
      state: "starting",
      accepted: previous?.accepted ?? 0,
    };
    if (route.discovered) record.discovered = true;
    status.routes[route.botId] = record;
    writeStatus();
    try {
      await superviseRoute(route, cutoverAt, record, signal);
    } catch {
      // Not expected. One route's fault must not end the process or the other routes.
      record.error = "route_failed";
    }
    record.state = "stopped";
    writeStatus();
    return record;
  };

  const superviseRoute = async (route, cutoverAt, record, signal) => {
    let failures = 0;
    while (!signal.aborted) {
      let bot;
      try {
        bot = selectBot(route, settings);
      } catch (error) {
        if (CREDENTIAL_PENDING.has(error.message)) {
          record.state = "waiting_for_credential";
          record.error = error.message;
        } else {
          record.state = "reconnecting";
          record.error = errorLabel(error);
        }
        writeStatus();
        await sleep(
          record.state === "waiting_for_credential"
            ? settings.reloadIntervalMs
            : backoff(settings.reconnectBaseMs, failures++),
          signal,
        );
        continue;
      }
      // Do not hold a relay socket for an agent that OpenBot will refuse. Its deliveries stay in
      // the relay queue until the owner turns "Local scripts" on.
      if (AUTOMATION_TRANSPORTS.has(route.transport) && exposed && !exposed.has(route.botId)) {
        record.state = "waiting_for_local_scripts";
        record.error = "automation_agent_not_listed";
        writeStatus();
        await sleep(settings.reloadIntervalMs, signal);
        continue;
      }
      try {
        await connectRoute(route, bot, cutoverAt, record, signal, () => {
          failures = 0;
        });
      } catch (error) {
        record.error = errorLabel(error);
      }
      if (signal.aborted) break;
      record.state = "reconnecting";
      writeStatus();
      await sleep(backoff(settings.reconnectBaseMs, failures++), signal);
    }
  };

  const connectRoute = async (route, bot, cutoverAt, record, signal, onOpen) => {
    const me = await relayApi(settings, bot, "/v1/agent");
    if (me.id !== bot.agentId || me.name !== bot.relayName) throw new Error("identity_mismatch");
    const node = await relayApi(settings, bot, "/v1/agent/node-token", "POST");
    if (node.node_id !== `node_direct_${bot.agentId}`) throw new Error("node_binding_mismatch");
    const send = wakeSender(route, settings);
    if (signal.aborted) return;
    const ws = new WebSocket(`${settings.relayWebSocketOrigin}/v1/node/ws?token=${encodeURIComponent(node.token)}`);
    const connection = ++connectionCount;
    const registerId = `wake-register-${connection}`;
    record.frames = {};
    await new Promise((resolve) => {
      let heartbeat;
      let heartbeats = 0;
      let registered = false;
      let finished = false;
      let chain = Promise.resolve();
      const onAbort = () => closeQuietly(ws);
      const sendFrame = (frame) => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
        } catch {
          // The close event ends this connection.
        }
      };
      // One deadline for the upgrade and the `node.register` reply: the relay pushes nothing before it.
      const timeout = setTimeout(() => {
        record.error = registered ? record.error : "socket_register_timeout";
        closeQuietly(ws);
      }, settings.socketOpenTimeoutMs);
      // The error and close events can both come, in either order. Only the first one counts.
      // Neither handler calls `close`: on Node 22 a close while the socket connects fires `error`
      // again in the same stack, and the deployed handler's recursion ended the whole process.
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        clearInterval(heartbeat);
        signal.removeEventListener("abort", onAbort);
        chain.finally(resolve);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      ws.onopen = () => {
        record.state = "registering";
        record.socketOpenedAt = new Date().toISOString();
        writeStatus();
        // The relay attaches this socket as the agent's delivery provider only after
        // `node.register`. Without it every push fails with "node socket send failed".
        sendFrame({
          v: 1,
          id: registerId,
          type: "node.register",
          node_id: node.node_id,
          name: typeof node.node_name === "string" && node.node_name ? node.node_name : node.node_id,
          provider: { name: "default", instance_id: crypto.randomUUID() },
          capabilities: [],
          max_agents: 1,
          tags: ["implicit", "direct", "openbot-wake"],
          version: NODE_VERSION,
        });
      };
      /** Replies and errors. They never wait behind a delivery that is being retried. */
      const handleControl = (frame) => {
        if (frame.type === "error") {
          record.lastErrorCode = safeCode(frame.code);
          record.lastErrorAt = new Date().toISOString();
        }
        if (frame.id === registerId) {
          if (frame.type === "reply" && frame.ok === true) {
            registered = true;
            clearTimeout(timeout);
            onOpen();
            record.state = "connected";
            delete record.error;
            record.connectedAt = new Date().toISOString();
            const capabilities = frame.data?.capabilities;
            record.relayCapabilities = Array.isArray(capabilities)
              ? capabilities.filter((value) => typeof value === "string").map(safeCode)
              : [];
            heartbeat = setInterval(() => {
              sendFrame({
                v: 1,
                id: `wake-heartbeat-${connection}-${++heartbeats}`,
                type: "node.heartbeat",
                node_id: node.node_id,
                load: null,
                active_agents: 1,
                handlers_live: false,
              });
            }, settings.heartbeatIntervalMs);
          } else {
            record.error = "relay_register_rejected";
            if (frame.type === "reply") record.lastErrorCode = safeCode(frame.error?.code ?? frame.code);
            closeQuietly(ws);
          }
        } else if (frame.type === "reply" && typeof frame.id === "string" && frame.id.startsWith("wake-heartbeat-")) {
          if (frame.ok === true) record.lastHeartbeatReplyAt = new Date().toISOString();
          else record.lastErrorCode = safeCode(frame.error?.code ?? frame.code);
        }
        writeStatus();
      };
      ws.onmessage = (event) => {
        const text = typeof event.data === "string" ? event.data : "";
        record.lastFrameAt = new Date().toISOString();
        let frame = null;
        if (text.length <= MAX_FRAME_CHARS) {
          try {
            frame = JSON.parse(text);
          } catch {
            frame = null;
          }
        }
        const type = typeof frame?.type === "string" && FRAME_TYPE.test(frame.type) ? frame.type : "invalid";
        record.frames[type] = (record.frames[type] ?? 0) + 1;
        if (type === "reply" || type === "error") return handleControl(frame);
        // `ping` needs no answer: the broker-to-relay schema has no pong, and the heartbeat
        // keeps the node live. `context.update` and other frames are counted only.
        if (type !== "deliver" && type !== "invalid") return writeStatus();
        chain = chain
          .then(async () => {
            if (signal.aborted) return;
            if (!frame) throw new Error(text.length > MAX_FRAME_CHARS ? "oversized_frame" : "invalid_frame");
            const cutoff =
              route.cutoverAt && Date.parse(route.cutoverAt) > Date.parse(cutoverAt) ? route.cutoverAt : cutoverAt;
            const metadata = projectFrame(frame, bot, cutoff);
            if (!metadata) return;
            const current = selectBot(route, settings);
            if (current.agentId !== bot.agentId || current.relayName !== bot.relayName)
              throw new Error("identity_changed");
            for (let attempt = 0; !signal.aborted; attempt++) {
              try {
                const sent = await forwardMetadata(metadata, route, send, ledger, () =>
                  atomicWrite(ledgerPath, ledger),
                );
                if (sent) {
                  record.accepted++;
                  record.lastDeliveryId = metadata.delivery_id;
                  record.lastAcceptedAt = new Date().toISOString();
                }
                if (ws.readyState === WebSocket.OPEN) record.state = "connected";
                delete record.error;
                writeStatus();
                break;
              } catch (error) {
                if (error.message === "delivery_identity_conflict" || error.message === "delivery_identity_unsafe")
                  throw error;
                if (error instanceof WakeRefused) {
                  // Only the owner can end this. Check again at the reload interval; other routes go on.
                  record.state = error.state;
                  record.error = error.message;
                  writeStatus();
                  await sleep(settings.reloadIntervalMs, signal);
                  continue;
                }
                record.error = /^(ingress|automation)_[a-z0-9_]+$/.test(error.message)
                  ? error.message
                  : "ingress_unavailable";
                writeStatus();
                await sleep(backoff(settings.retryBaseMs, attempt), signal);
              }
            }
          })
          .catch(() => {
            record.error = "frame_rejected";
            writeStatus();
            closeQuietly(ws);
          });
      };
      ws.onclose = finish;
      ws.onerror = () => {
        record.error = record.error === "socket_timeout" ? "socket_timeout" : "socket_error";
        finish();
      };
    });
  };

  /** Starts new and changed routes and stops removed ones. Unchanged routes keep their sockets. */
  const applyRoutes = (cutoverAt, routes) => {
    const routeKey = (route) => {
      const { discovered: _discovered, ...definition } = route;
      return JSON.stringify([cutoverAt, definition]);
    };
    const wanted = new Map(routes.map((route) => [route.botId, route]));
    for (const [botId, entry] of running) {
      const route = wanted.get(botId);
      if (!route || entry.key !== routeKey(route)) {
        entry.controller.abort();
        running.delete(botId);
        if (!route)
          entry.done.then((record) => {
            if (status.routes[botId] === record) delete status.routes[botId];
            writeStatus();
          });
      }
    }
    for (const route of routes) {
      if (running.has(route.botId)) continue;
      const controller = new AbortController();
      // A changed route starts after its earlier loop ends, so one agent never has two sockets.
      const done = (loops.get(route.botId) ?? Promise.resolve()).then(() =>
        runRoute(route, cutoverAt, controller.signal),
      );
      loops.set(route.botId, done);
      running.set(route.botId, { key: routeKey(route), controller, done });
    }
  };

  let reloading = false;
  const reload = async () => {
    if (reloading || stopping) return;
    reloading = true;
    try {
      const parsed = parseRoutes(JSON.parse(readPrivate(configPath)));
      const configured = new Set(parsed.routes.map((route) => route.botId));
      if (settings.discoverAutomationRoutes) {
        try {
          discovered = discoverMessageRoutes(settings, configured).routes.map((route) => ({
            ...route,
            discovered: true,
          }));
          delete status.discoveryError;
        } catch (error) {
          // Keep the routes found before: an unreadable credential file does not remove an agent.
          status.discoveryError = errorLabel(error);
        }
      }
      // A configured route always wins over a discovered one.
      const routes = [...parsed.routes, ...discovered.filter((route) => !configured.has(route.botId))];
      if (routes.some((route) => AUTOMATION_TRANSPORTS.has(route.transport))) {
        const answer = await automationAgents(settings);
        if (answer) exposed = answer;
      }
      if (stopping) return;
      applyRoutes(parsed.cutoverAt, routes);
      status.routeCount = running.size;
      status.configLoadedAt = new Date().toISOString();
      delete status.configError;
    } catch (error) {
      // A bad edit keeps the routes that already run.
      status.configError = /^(invalid_|duplicate_|private_)/.test(error.message) ? error.message : "config_unreadable";
    } finally {
      reloading = false;
      writeStatus();
    }
  };

  const stop = () => {
    stopping = true;
    stopController.abort();
    for (const entry of running.values()) entry.controller.abort();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    await reload();
    while (!stopping) {
      await sleep(settings.reloadIntervalMs, stopController.signal);
      await reload();
    }
    await Promise.all(loops.values());
  } finally {
    releaseLock();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    const label = /^(static_config_|listener_|private_)[a-z_]*$/.test(error?.message)
      ? error.message
      : "listener_configuration_or_runtime";
    console.error(JSON.stringify({ state: "failed", error: label }));
    process.exitCode = 1;
  });
}
