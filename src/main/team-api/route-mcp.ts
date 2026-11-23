import { MCP_SERVERS_CAPABILITY } from "@openbot/contracts/ipc";
import {
  MCP_FROZEN_SERVERS_LIST_LIMIT,
  MCP_MANY_SERVERS_CAPABILITY,
  MCP_MANY_SERVERS_LIST_LIMIT,
} from "@openbot/contracts/team-protocol/mcp-many-servers-v1";
import { MCP_SERVER_PAGES_CAPABILITY } from "@openbot/contracts/team-protocol/mcp-pages-v1";
import { MCP_ROUTES, mcpRequest } from "@openbot/contracts/team-protocol/mcp-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import {
  parseRemoveMcpServer,
  parseSaveMcpServer,
  parseSetMcpServerEnabled,
  parseTestMcpServer,
} from "../ipc/mcp-inputs";
import { type McpToolRuntimePreparation, prepareToolRuntimeForTest } from "../ipc/mcp-server-handlers";
import type { TeamApiMcpServerOwners, TeamApiMcpServers } from "./dependencies";
import { HttpError } from "./http-error";
import {
  requireMcpAccess,
  requireOwnMcpServer,
  requireVisibleMcpAddress,
  requireVisibleMcpTest,
  visibleMcpServers,
} from "./mcp-member-access";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";

/**
 * A peer with `mcp-server-pages-v1` and without `mcp-many-servers-v1` reads the rows after the first
 * 32 through the page routes. For it, the `mcp-v1` and `mcp-sign-in-v1` routes keep their 32-row
 * answer and their bound of 32 on a new server.
 */
function readsMcpPagesOnly(capabilities: ReadonlySet<string>): boolean {
  return capabilities.has(MCP_SERVER_PAGES_CAPABILITY) && !capabilities.has(MCP_MANY_SERVERS_CAPABILITY);
}

/**
 * Refuses a peer without `mcp-many-servers-v1` a list longer than its frozen codec reads. The check
 * runs before the route changes anything, so the peer does not get a protocol error after a change
 * that the host already made. A peer that reads pages is not refused: `peerMcpRows` cuts its list.
 */
export function requireMcpListFits(capabilities: ReadonlySet<string>, rows: number): void {
  if (
    rows > MCP_FROZEN_SERVERS_LIST_LIMIT &&
    !capabilities.has(MCP_MANY_SERVERS_CAPABILITY) &&
    !capabilities.has(MCP_SERVER_PAGES_CAPABILITY)
  )
    throw new HttpError(
      409,
      sourceText("error.team.mcpServerListNeedsUpdate", { limit: MCP_FROZEN_SERVERS_LIST_LIMIT }),
    );
}

/**
 * The rows of a list answer that the codec of this peer reads: 100 with `mcp-many-servers-v1`, and
 * 32 without it. This host can hold more rows than either; the page routes carry all of them.
 */
export function peerMcpRows<T>(capabilities: ReadonlySet<string>, rows: readonly T[]): T[] {
  return rows.slice(
    0,
    capabilities.has(MCP_MANY_SERVERS_CAPABILITY) ? MCP_MANY_SERVERS_LIST_LIMIT : MCP_FROZEN_SERVERS_LIST_LIMIT,
  );
}

/**
 * The MCP servers of the machine that runs this host, managed from a joined server.
 *
 * An admin check runs on all five verbs, `list` included: a response carries every `env` value and
 * every header value the host holds, so reading is as privileged as writing. Saving an enabled
 * stdio configuration makes this machine spawn that process, and a test spawns one the caller has
 * only described. All of it was decided deliberately and is frozen by `mcp-v1`; narrowing any of it
 * needs a second capability string. `mcp-member-access-v1` is that second string the other way: with
 * it, a member gets the same routes, and changes or removes only a server that the member added.
 *
 * Every route but `test` answers with the whole list, so a client never merges a partial result.
 */
export async function routeMcpServers(
  context: TeamApiRequestContext,
  mcpServers: TeamApiMcpServers | undefined,
  toolRuntimes?: McpToolRuntimePreparation,
  owners?: TeamApiMcpServerOwners,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  const list = method === "GET" && url.pathname === MCP_ROUTES.list;
  const save = method === "POST" && url.pathname === MCP_ROUTES.save;
  const remove = method === "POST" && url.pathname === MCP_ROUTES.remove;
  const toggle = method === "POST" && url.pathname === MCP_ROUTES.toggle;
  const test = method === "POST" && url.pathname === MCP_ROUTES.test;
  if (!list && !save && !remove && !toggle && !test) return "unmatched";
  if (!mcpServers || !capabilities.has(MCP_SERVERS_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.mcpUnsupported"));
  const access = requireMcpAccess(member, capabilities, owners);
  if (list) {
    const servers = mcpServers.listMcpServers();
    requireMcpListFits(capabilities, servers.length);
    return json(200, peerMcpRows(capabilities, visibleMcpServers(access, servers)));
  }
  const body = mcpRequest(url.pathname, await readJson(request));
  if (save) {
    const input = parseSaveMcpServer(body);
    const rows = mcpServers.listMcpServers();
    if (readsMcpPagesOnly(capabilities) && !input.config.id && rows.length >= MCP_FROZEN_SERVERS_LIST_LIMIT)
      throw new HttpError(400, sourceText("error.backend.mcpServerLimit", { limit: MCP_FROZEN_SERVERS_LIST_LIMIT }));
    const before = new Set(rows.map((server) => server.id));
    if (before.has(input.config.id)) requireOwnMcpServer(access, input.config.id);
    if (input.config.transport === "http") requireVisibleMcpAddress(access, rows, input.config.url);
    requireMcpListFits(capabilities, before.size + (before.has(input.config.id) ? 0 : 1));
    toolRuntimes?.startToolRuntimes();
    const saved = await runCauseEffect(mcpServers.saveMcpServer(input));
    const name = input.config.name.trim();
    const added = saved.find((server) => !before.has(server.id) && server.name === name);
    if (added && owners) await runCauseEffect(owners.add(added.id, member.id));
    return json(200, peerMcpRows(capabilities, visibleMcpServers(access, saved)));
  }
  if (remove) {
    const input = parseRemoveMcpServer(body);
    requireOwnMcpServer(access, input.mcpServerId);
    const rows = mcpServers.listMcpServers();
    requireMcpListFits(capabilities, rows.length - (rows.some((server) => server.id === input.mcpServerId) ? 1 : 0));
    const servers = await runCauseEffect(mcpServers.removeMcpServer(input));
    if (owners) await runCauseEffect(owners.remove(input.mcpServerId));
    return json(200, peerMcpRows(capabilities, visibleMcpServers(access, servers)));
  }
  if (test) {
    const parsed = parseTestMcpServer(body);
    requireVisibleMcpTest(access, mcpServers.listMcpServers(), parsed.config);
    if (toolRuntimes) await runCauseEffect(prepareToolRuntimeForTest(parsed.config, toolRuntimes));
    return json(
      200,
      await runCauseEffect(mcpServers.testMcpServer(parsed, { storedCredentials: true, signInPlace: "host" })),
    );
  }
  const toggled = parseSetMcpServerEnabled(body);
  requireOwnMcpServer(access, toggled.mcpServerId);
  requireMcpListFits(capabilities, mcpServers.listMcpServers().length);
  if (toggled.enabled) toolRuntimes?.startToolRuntimes();
  return json(
    200,
    peerMcpRows(capabilities, visibleMcpServers(access, await runCauseEffect(mcpServers.setMcpServerEnabled(toggled)))),
  );
}
