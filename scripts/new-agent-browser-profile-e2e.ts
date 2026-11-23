// Fork only. Checks the host preference file `openbot-new-agent-browser-profile-v1.json`: a new agent
// starts on the named browser profile that the file names. Runs the real agent store, agent service,
// browser profile store and `TeamApiServer` on a temporary profile, with a fake Codex app-server that
// answers each first message. The store reads the file through `newAgentBrowserProfile`, wired as
// `application-services.ts` wires it.
// The check proves: with no file, a new agent is on Shared; a valid file gives the named profile through
// the local create path, the Team API create route and the template path; the next agent reads a changed
// file with no restart; a missing profile or an invalid file gives Shared and the creation continues;
// an import stays on Shared; a duplicate keeps its source's profile; an existing agent does not change;
// and the stored record holds the profile.
// Run: `bun scripts/new-agent-browser-profile-e2e.ts`.
// Writes .openbot-build/new-agent-browser-profile-e2e/report.json.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentSummary } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol";
import { teamCapabilitiesForProtocol } from "@openbot/contracts/team-protocol/current";
import { TEAM_PROTOCOL_V7 } from "@openbot/contracts/team-protocol/v7";
import { plugin } from "bun";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { TeamApiBrowser } from "../src/main/team-api/dependencies";

const OUT = resolve(import.meta.dirname, "../.openbot-build/new-agent-browser-profile-e2e");
const HOST_VERSION = "0.0.0-e2e";
const OWNER = { username: "owner-user", password: "owner-password-123" };
const STEP_DEADLINE_MS = 30_000;

const root = await mkdtemp(join(tmpdir(), "openbot-new-agent-browser-profile-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });
mkdirSync(userData, { recursive: true });

// The Team API server imports Electron for its windows and IPC. No check here opens a window.
plugin({
  name: "new-agent-browser-profile-electron-boundary",
  setup(build) {
    class Inert {}
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: { getPath: () => tmpdir(), getVersion: () => HOST_VERSION, isPackaged: false, on: () => undefined },
        BrowserWindow: Object.assign(class extends Inert {}, { getAllWindows: () => [] }),
        MessageChannelMain: class extends Inert {},
        Notification: Object.assign(class extends Inert {}, { isSupported: () => false }),
        clipboard: {},
        dialog: {},
        ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
        nativeImage: {},
        net: {},
        powerMonitor: { on: () => undefined },
        safeStorage: { isEncryptionAvailable: () => false },
        screen: {},
        session: {},
        shell: { openExternal: async () => undefined },
        systemPreferences: {},
        webContents: { getAllWebContents: () => [] },
      },
    }));
  },
});

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { duplicateAgentIntoLayout } = await import("../src/backend/agent/duplication-gate");
const { BrowserProfileStore } = await import("../src/backend/browser-profiles/browser-profile-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { SidebarLayoutStore } = await import("../src/backend/sidebar-layout-store");
const { NEW_AGENT_BROWSER_PROFILE_FILE, newAgentBrowserProfile } = await import(
  "../src/main/new-agent-browser-profile"
);
const { TeamApiServer } = await import("../src/main/team-api-server");
const { TeamStore } = await import("../src/main/team-store");

/** A Codex app-server with the methods that the service calls. Each turn answers "Done.". */
const FAKE_CODEX = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.166.0\\n");
  process.exit(0);
}
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + process.pid + "-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
      write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; steps: Step[]; error?: string } = { passed: false, steps: [] };

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // A bound on failure only: each check waits for its result.
    const value = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`No result within ${STEP_DEADLINE_MS} ms.`)), STEP_DEADLINE_MS);
      }),
    ]);
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

const unused = () => Effect.die(new Error("Not used by this check."));
const agentBrowser: AgentBrowserHost = {
  listTabs: () => [],
  toolCanUseTab: () => false,
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
  shareTab: () => undefined,
  unshareThread: () => undefined,
  agentTab: () => null,
};
const teamBrowser: TeamApiBrowser = {
  listTabs: () => [],
  getControlState: () => ({ sessions: [] }),
  open: unused,
  activate: unused,
  navigate: unused,
  reload: unused,
  stop: unused,
  takeUserControl: unused,
  releaseUserControl: () => {},
  releaseUserControlHeldBy: () => {},
  releaseUserControlRefused: () => {},
  close: unused,
  capturePreview: unused,
  setVisible: unused,
  getDisplayState: () => ({ tabs: [], activeTabId: null }),
  loadUrl: unused,
  isPrivate: () => false,
  startView: unused,
  dispatchViewInput: unused,
  copyViewSelection: unused,
  importSignIn: unused,
  startTeach: unused,
  stopTeach: () => [],
};

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const preferencePath = join(userData, NEW_AGENT_BROWSER_PROFILE_FILE);
const database = new OpenBotDatabase(userData);
const profiles = new BrowserProfileStore(database);
const store = new AgentStore(
  userData,
  home,
  database,
  undefined,
  undefined,
  newAgentBrowserProfile(preferencePath, (profileId) => profiles.get(profileId) !== undefined),
);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
const team = new TeamStore(join(userData, "openbot-team-server-v2.json"));
const agents = new AgentService({
  store,
  mailbox,
  browser: agentBrowser,
  sidebarLayout: sidebar,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
});
let server: InstanceType<typeof TeamApiServer> | null = null;

/** The stored fields that choose the browser session, as the next launch reads them from the database. */
function storedProfile(agentId: string) {
  const agent = database.listAgents().find((candidate) => candidate.id === agentId);
  assert.ok(agent, `Agent ${agentId} is not stored.`);
  return { ownBrowserSession: agent.ownBrowserSession, browserProfileId: agent.browserProfileId };
}

const SHARED = { ownBrowserSession: undefined, browserProfileId: undefined };
const onProfile = (profileId: string) => ({ ownBrowserSession: true, browserProfileId: profileId });

/** The browser fields of every agent, to show that a step changes no existing agent. */
function snapshot(): Map<string, string> {
  return new Map(
    store.list().map((agent) => [agent.id, JSON.stringify([agent.ownBrowserSession, agent.browserProfileId])]),
  );
}

function assertUnchanged(before: Map<string, string>) {
  for (const [id, fields] of before) assert.equal(snapshot().get(id), fields, `Existing agent ${id} changed.`);
}

const writePreference = (value: unknown) =>
  writeFile(preferencePath, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);

/** The local create path: the IPC handler and the agent tool call `AgentService.createAgent`. */
const createLocal = (name: string): Promise<AgentSummary> =>
  runCauseEffect(
    agents.createAgent({
      name,
      description: name,
      avatarSeed: name.toLowerCase().replaceAll(" ", "-"),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );

/** The template, marketplace and messaging path, or an import when `imported` is true. */
const createProfile = (name: string, imported = false): Promise<AgentSummary> =>
  runCauseEffect(
    agents.createAgentProfile({
      name,
      description: name,
      avatarSeed: name.toLowerCase().replaceAll(" ", "-"),
      avatarHue: null,
      ...(imported ? { imported: true } : {}),
    }),
  );

let port = 0;
async function call(method: string, path: string, input: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    [TEAM_PROTOCOL_VERSION_HEADER]: String(TEAM_PROTOCOL_V7),
    [TEAM_APP_VERSION_HEADER]: HOST_VERSION,
    [TEAM_CAPABILITIES_HEADER]: teamCapabilitiesForProtocol(TEAM_PROTOCOL_V7).join(","),
  };
  if (input.body !== undefined) headers["Content-Type"] = "application/json";
  if (input.token) headers.Authorization = `Bearer ${input.token}`;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: input.body === undefined ? null : JSON.stringify(input.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const idle = () =>
  store
    .list()
    .every((agent) =>
      agents
        .listQueue(agent.id)
        .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
    );

try {
  await runCauseEffect(sidebar.initialize());
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  await runCauseEffect(team.initialize());
  await runCauseEffect(team.configure("E2E Host", OWNER.username, OWNER.password));
  await runCauseEffect(agents.initialize());
  server = new TeamApiServer({
    store: team,
    agents,
    mailbox,
    browser: teamBrowser,
    sidebarLayout: sidebar,
    appVersion: HOST_VERSION,
  });
  port = await Effect.runPromise(server.start());
  const login = await call("POST", TEAM_API_ROUTES.auth.login, { body: OWNER });
  assert.equal(login.status, 200, `Sign-in returned ${login.status}.`);
  const token: string = login.body.sessionToken;

  const fallback = profiles.create("Default", 0);
  const other = profiles.create("Other", 0);

  const existing = await step("With no file, a new agent is on Shared", async () => {
    const local = await createLocal("No File Local");
    const template = await createProfile("No File Template");
    assert.deepEqual(storedProfile(local.id), SHARED);
    assert.deepEqual(storedProfile(template.id), SHARED);
    return { ids: [local.id, template.id], local: storedProfile(local.id), template: storedProfile(template.id) };
  });

  await step("A valid file gives the named profile on the local create path", async () => {
    const before = snapshot();
    await writePreference({ version: 1, profileId: fallback.id });
    const agent = await createLocal("Local");
    assert.deepEqual(storedProfile(agent.id), onProfile(fallback.id));
    assert.deepEqual(
      { ownBrowserSession: agent.ownBrowserSession, browserProfileId: agent.browserProfileId },
      onProfile(fallback.id),
      "The returned agent has the profile.",
    );
    assertUnchanged(before);
    return { existingAgents: before.size, stored: storedProfile(agent.id) };
  });

  await step("A valid file gives the named profile on the Team API create route", async () => {
    const before = snapshot();
    const response = await call("POST", TEAM_API_ROUTES.agents.all, {
      token,
      body: {
        name: "Team API",
        description: "",
        avatarSeed: "team-api",
        avatarHue: null,
        initialMessage: "Hello.",
      },
    });
    assert.equal(
      response.status,
      201,
      `The create route returned ${response.status}: ${JSON.stringify(response.body)}`,
    );
    // The released agent reply does not carry the profile fields, so the check reads the host's record.
    assert.deepEqual(storedProfile(response.body.id), onProfile(fallback.id));
    assertUnchanged(before);
    return { status: response.status, stored: storedProfile(response.body.id) };
  });

  await step("A valid file gives the named profile on the template path, and an import stays on Shared", async () => {
    const template = await createProfile("Template");
    const imported = await createProfile("Imported", true);
    assert.deepEqual(storedProfile(template.id), onProfile(fallback.id));
    assert.deepEqual(storedProfile(imported.id), SHARED);
    return { template: storedProfile(template.id), imported: storedProfile(imported.id) };
  });

  await step("A changed file applies to the next agent with no restart", async () => {
    const before = snapshot();
    await writePreference({ version: 1, profileId: other.id });
    const agent = await createLocal("After Change");
    assert.deepEqual(storedProfile(agent.id), onProfile(other.id));
    assertUnchanged(before);
    return storedProfile(agent.id);
  });

  await step("A file that names a missing profile gives Shared, and the creation continues", async () => {
    await writePreference({ version: 1, profileId: randomBytes(16).toString("hex") });
    const local = await createLocal("Missing Profile");
    const template = await createProfile("Missing Profile Template");
    assert.deepEqual(storedProfile(local.id), SHARED);
    assert.deepEqual(storedProfile(template.id), SHARED);
    return { local: storedProfile(local.id), template: storedProfile(template.id) };
  });

  await step("An invalid file gives Shared, and the creation continues", async () => {
    const invalid: Array<[label: string, text: string]> = [
      ["notJson", "{ not json"],
      ["wrongVersion", JSON.stringify({ version: 2, profileId: fallback.id })],
      ["badId", JSON.stringify({ version: 1, profileId: "Default" })],
      ["empty", ""],
    ];
    const results: Array<{ label: string; stored: ReturnType<typeof storedProfile> }> = [];
    for (const [label, text] of invalid) {
      await writePreference(text);
      const agent = await createLocal(`Invalid ${label}`);
      assert.deepEqual(storedProfile(agent.id), SHARED, `${label} gave a profile.`);
      results.push({ label, stored: storedProfile(agent.id) });
    }
    return results;
  });

  await step("A duplicate keeps its source's profile", async () => {
    await writePreference({ version: 1, profileId: fallback.id });
    // Sources with no first message, because a duplicate waits for an empty queue.
    const named = await createProfile("Named Source");
    await runCauseEffect(store.updateAgent({ agentId: named.id, browserProfileId: other.id }));
    const shared = store.list().find((agent) => agent.id === existing.ids[1]);
    assert.ok(shared, "The Shared source is missing.");
    const duplicate = async (sourceId: string) => {
      const result = await runCauseEffect(duplicateAgentIntoLayout(agents, sidebar, sourceId));
      return storedProfile(result.agent.id);
    };
    const namedCopy = await duplicate(named.id);
    const sharedCopy = await duplicate(shared.id);
    assert.deepEqual(namedCopy, onProfile(other.id), "The copy of a named-profile agent left its profile.");
    assert.deepEqual(sharedCopy, SHARED, "The copy of a Shared agent took the file's profile.");
    return { namedCopy, sharedCopy };
  });

  await step("The first agents keep their profile to the end", async () => {
    for (const id of existing.ids) assert.deepEqual(storedProfile(id), SHARED);
    return existing.ids.map(storedProfile);
  });

  // Wait for the first-message turns to end before the stop, so no turn is cut off.
  const waitIdle = async () => {
    while (!idle()) await new Promise((done) => setTimeout(done, 25));
  };
  await step("Every first-message turn ends", async () => {
    await waitIdle();
    return { agents: store.list().length };
  });

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (server) await Effect.runPromise(server.stop()).catch(() => undefined);
  await runCauseEffect(agents.stop()).catch(() => undefined);
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")} (${report.passed ? "passed" : "failed"})\n`);
}
