# Agent Relay for hosted OpenBot

This optional Linux setup gives each OpenBot agent on a server its own Agent Relay identity,
`openbot-<server>-<agent>`, with its own agent token. Agents use it to send and receive relay
messages. The files are in `scripts/hosting/agent-relay/`. The installed copy is in
`/opt/openbot-agent-relay/`.

## Parts

| Part | Unit | User | Function |
| --- | --- | --- | --- |
| `relay-provision.py` | `openbot-agent-relay-provision.service` | `openbot-relay` | Holds the Relaycast workspace key. Creates or adopts agent identities. |
| `relay-messaging.py` | `openbot-agent-relay-messaging.service` | `openbot` | Asks the provisioner for credentials, verifies tokens, sends heartbeats. Agents use its CLI. |
| `identity-sync.py` | `openbot-agent-relay-identity.service` | `openbot` | Writes the relay name and commands into each agent's instruction file. Labels history sessions. |
| `history-watch.py` | `openbot-agent-relay-history.service` | `openbot` | Keeps the Agent Relay history collector running. |
| `agent-relay-probe` | `openbot-agent-relay-enroll.service` | `openbot` | One-time history enrollment. |
| `recipient-wake.mjs` | `openbot-agent-relay-wake.service` | `openbot` | Wakes an agent when its inbox gets a delivery. |
| `wake-routes.mjs` | - | `openbot` | Operator tool that adds wake routes for new agents. |
| `relay-config.py` | - | - | Reads the shared config. |
| `install.py` | - | root | Installs all the parts above. |

### Credentials

The provisioner is the only process with the workspace key. systemd gives it the key with
`LoadCredential=` from `/etc/openbot-agent-relay/workspace-key` (root, mode 0600). The `openbot`
user, which runs the agents, cannot read the key.

The provisioner listens on `/run/openbot-agent-relay/provision/provision.sock`. It accepts a
connection only when the peer uid (`SO_PEERCRED`) is the uid of `provisioner.clientUser`.

The provisioner keeps no registry. The agent record at the relay is the source of truth: its name
and its `openbot_server_id` and `openbot_bot_id` metadata. For each requested agent:

| Relay record | Caller token | Result |
| --- | --- | --- |
| None | None | Create the agent. Return its id and token. |
| None | Given | `identity_removed`. Nothing is created. |
| Same server and agent id | Valid for that record | Adopt. Update the session metadata if it changed. The token does not change. |
| Same server and agent id | None | `recovery_required` |
| Same server and agent id | Not valid | `token_rejected` |
| Other server or agent id | Any | `identity_conflict`. Nothing changes. |

The provisioner refuses each name that is not `openbot-<serverName>-<slug>`, or the hash-suffixed
form that `identity-sync.py` makes. Each agent gets its own result. One refused agent does not
stop the others.

`relay-messaging.py` saves the tokens in
`~openbot/.local/state/openbot-agent-relay/messaging-credentials.json` (mode 0600). The wake
listener and the agent CLI commands read this file. Its format did not change. The old
`server-credential.json` is not used any more.

### Status

`messaging-status.json`, in the same folder, has only counts and fixed labels:

```json
{"state": "ready", "profiles": 28, "registered": 28, "verified": 28, "heartbeats": 28, "failed": 0, "failures": {}}
```

`state` is `ready` when no agent failed, `degraded` when some agents failed, and `waiting` when the
cycle could not start (then `error` has a label). `failures` maps an agent id to a label.

## Session names

`identity-sync.py` writes the agent's relay name, for example `openbot-<server>-tony`, into the
`agent_name` field of each history session that it can attribute. It also writes one
`openbot_identity` marker per session. The history collector sends the index to Agent Relay.
There are three kinds of attribution:

| Kind | Evidence | Marker |
| --- | --- | --- |
| `conversation` | OpenBot's own record: the provider session of an agent's conversation. This always wins. | `attribution: openbot_provider_session`, with the OpenBot thread id. Same shape as before. |
| `parent` | The session's parent chain in `session_relationships` (at most 16 steps, no loops) ends at an attributed session. | `attribution: openbot_parent_session`, `attribution_kind: parent`, `parent_session_id`. No OpenBot thread id. |
| `workspace` | The session's `cwd` and each workspace root are the agent's `workspacePath` or a folder in it. Whole path parts are compared, so `.../agent-x-old` does not match `.../agent-x`. | `attribution: openbot_agent_workspace`, `attribution_kind: workspace`. No OpenBot thread id. |

A `parent` or `workspace` session is a side run that the agent started, for example a
`codex exec` review. It is not the agent's conversation.

These sessions stay without a name. The journal line counts them in `unnamed_by_reason`:

| Reason | Why |
| --- | --- |
| `root_directory` | `cwd` is `/`. Background runs of a provider use it, not an agent. |
| `unknown_agent_workspace` | A workspace folder of an agent that is not in the roster, for example a deleted agent. |
| `removed_agent_conversation` | A conversation of an agent that is not in the roster. |
| `shared_directory`, `temporary_directory` | A shared folder, or `/tmp`, `/var/tmp`, `/dev/shm`. More than one agent can use them. |
| `conflicting_evidence` | The paths name more than one agent, or the paths and the parent name different agents. |
| `outside_agent_workspaces`, `no_path` | No evidence links the session to an agent. |

The helper never makes a server-level name. It never replaces a name that another source set
(`kept_other_name`). It never removes a name: when the evidence goes away later, for example
when an agent is deleted, the session keeps its name and marker
(`kept_without_current_evidence`). Before the first change of a session, the old value is saved
in `original-agent-names.json`. Each change advances the change-feed revision, so the collector
sends it again. A repeat run with no new evidence changes nothing.

Run `identity-sync.py --dry-run --once` as the OpenBot user to see the counts without a change. A
dry run opens the history index read-only, takes no lock and writes no file, so it can run next to
the service.

## Data that leaves the server

All requests go to `relayOrigin` over HTTPS, with no redirects, a 15 or 20 second timeout and a
response size limit.

- The provisioner sends the workspace key, each agent's relay name, the server name and id, the
  agent id and name, the newest provider session id and kind, and the OpenBot thread id. The
  values of `provisioner.agentMetadata` go into each new agent record.
- To prove possession, the provisioner sends the caller's agent token to `GET /v1/agent`.
- The operator command `recover --apply` sends `DELETE /v1/agents/<name>` with the key.
- The messaging helper sends each agent token for verification and heartbeats. Agents send their
  own messages with the CLI.
- The history collector sends the history index, which now also has the relay name and the
  identity marker of each attributed session (agent id and name, relay name, server name, and the
  OpenBot thread id or the parent session id).
- No conversation text, file or attachment is sent by these helpers. The history collector is a
  separate part with its own sharing settings.

## Config

`/etc/openbot-agent-relay/config.json` holds the deployment values. It has no secrets. It must be
owned by root and must not be writable by group or others; the same applies to its folder. The
helpers refuse a config that does not obey this rule, because the config chooses where the key
and the tokens go. `OPENBOT_AGENT_RELAY_CONFIG` can name another file.

Start from `scripts/hosting/agent-relay/config.example.json`. Keep the real values out of Git.

| Key | Use |
| --- | --- |
| `version` | Must be `1`. |
| `serverName` | Lowercase server name in each relay name. |
| `serverId` | Value of `openbot_server_id` at the relay. Default: `serverName`. It must equal `serverId` in the credentials file. |
| `relayOrigin` | Relaycast API origin. HTTPS only. |
| `relayWorkspaceId` | The provisioner checks that the key belongs to this workspace (`GET /v1/workspace`). |
| `serviceUser`, `serviceHome` | The OpenBot user and its home. |
| `provisioner.user`, `.socket`, `.clientUser` | Provisioner user, socket path (under `/run/`) and the only permitted peer. |
| `provisioner.agentMetadata` | Extra string metadata for new agents, for example `cloud_workspace_id` and `owner_hash`. |
| `history.database`, `.probe`, `.account`, `.workspace` | History collector values. |
| `wake` | Wake listener values. All are optional: `discoverAutomationRoutes`, `messageTemplate`, `heartbeatIntervalMs`, `ingressHosts`, `stateDir`, `credentialsPath`, `automationRoot`, `reloadIntervalMs`, `reconnectBaseMs`, `retryBaseMs`, `socketOpenTimeoutMs`. Omit `relayWebSocketOrigin`: the listener derives it from `relayOrigin`. The installer uses `stateDir` for the wake unit's `ReadWritePaths`. The wake listener validates this section. |

## Install

One procedure installs all parts: the provisioner, the messaging and identity helpers, the history
collector, and the wake listener. Run these steps on the server as root, from an extracted copy of
`scripts/hosting/agent-relay/`.

1. Save copies of the current files:

   ```sh
   B=/root/agent-relay-backup-$(date -u +%Y%m%dT%H%M%SZ)
   install -d -m 0700 "$B"
   cp -a /opt/openbot-agent-relay "$B/opt"
   cp -a /etc/systemd/system/openbot-agent-relay-* "$B/"
   sudo -u openbot cp -p ~openbot/.local/state/openbot-agent-relay/messaging-credentials.json \
     ~openbot/.local/state/openbot-agent-relay/messaging-credentials.before-provisioner.json
   ```

2. Write the config: `install -d -m 0755 /etc/openbot-agent-relay`, then write
   `/etc/openbot-agent-relay/config.json` with mode 0644. Start from `config.example.json`.
3. Read the plan: `python3 install.py`. It changes nothing.
4. The owner gets the workspace key: the owner signs in to Agent Relay Cloud with the device
   sign-in, then gets the key of the relay workspace from the workspace `resolve` endpoint. Write
   the key only as root, without echo and without shell history:

   ```sh
   ( umask 077; read -rs KEY; printf '%s' "$KEY" > /etc/openbot-agent-relay/workspace-key; unset KEY )
   chmod 0600 /etc/openbot-agent-relay/workspace-key
   ```

   Do not put the key in a log, a ticket, the config or Git.
5. Install: `python3 install.py --apply --backup-dir "$B/install"`. It creates the user
   `openbot-relay`, copies the helpers and the wake files (`recipient-wake.mjs`,
   `wake-routes.mjs`) to `/opt/openbot-agent-relay/`, renders all six units and runs
   `systemctl daemon-reload`. It does not start or restart a unit. It keeps the first original of
   each replaced file in the backup folder and lists the files in `manifest.json`. It is safe to
   run again.
6. Start the parts in this order:

   ```sh
   systemctl enable --now openbot-agent-relay-provision.service
   journalctl -u openbot-agent-relay-provision.service -n 5    # expect "listening"
   systemctl restart openbot-agent-relay-messaging.service
   # Wait until messaging-status.json shows the expected counts (see Verify).
   systemctl restart openbot-agent-relay-identity.service
   systemctl restart openbot-agent-relay-history.service
   systemctl restart openbot-agent-relay-wake.service
   ```

## Wake on receive

The wake listener starts an agent turn when a relay delivery arrives for that agent. It never
reads, acknowledges or answers a delivery: the agent reads its own inbox and acknowledges there.

For each route, the listener gets a node token with the agent's own token
(`POST /v1/agent/node-token`), opens the node WebSocket and sends `node.register`. The relay pushes
`deliver` frames only to a registered node. A socket that sends no `node.register` gets nothing,
and each delivery shows `last_dispatch_error: "node socket send failed"`. After the register reply,
the relay sends each unacknowledged delivery that has not expired, then the new ones. The listener
sends `node.heartbeat` every 15 seconds; the relay marks a node offline after 45 seconds. A ledger
(`wake/accepted.json`) makes sure that one delivery wakes the agent one time.

| Route `transport` | Wake target | Needs |
| --- | --- | --- |
| `message` | `POST /v1/agents/<agent-id>/messages` on the loopback automation server of OpenBot. The text has only the delivery ID and the inbox commands. | "Local scripts" on for the agent. No routine, secret or webhook slot. |
| `hookdeck` (default for a route with no `transport`) | An authenticated Hookdeck source that signs the event and sends it to the agent's webhook routine. | A webhook routine, its secret, and Hookdeck plumbing for each agent. |
| `automation` | `POST /v1/agents/<agent-id>/routines/<routine-id>/run`. | "Local scripts" on, and a schedule routine. The automation server does not list or run a webhook routine. |

Routes in `<stateDir>/config.json` are explicit. With `wake.discoverAutomationRoutes` set to
`true`, each agent that has a verified credential and no explicit route gets a `message` route.
The listener reads the route file and the credentials again at each reload interval, so a new
agent gets a route with no restart. `wake-routes.mjs` shows the same plan (dry run) and can write
it to the route file with `--apply`.

`<stateDir>/status.json` shows each route: `state`, `wake`, `accepted`, `lastDeliveryId`, `frames`
(count by frame type), `lastFrameAt` and `lastErrorCode`. It has no token and no message text.

| Route state | Meaning |
| --- | --- |
| `connected` | The node is registered and the relay can push. |
| `registering` | The socket is open and the register reply did not come yet. |
| `waiting_for_credential` | The agent has no verified relay credential yet. |
| `waiting_for_local_scripts` | "Local scripts" is off for the agent. The listener holds no socket; deliveries stay in the relay queue. |
| `agent_hidden` | A host before v0.71.0 refused the wake (409) because the agent is hidden. From v0.71.0 a hidden agent takes work, and the host does not give this answer. |
| `reconnecting` | The socket closed. The listener connects again with backoff. |

Limits:

- The relay removes an unacknowledged delivery from the inbox one hour after it was sent. An agent
  that cannot be woken in that hour does not get that delivery in its inbox.
- The automation server permits 30 requests an hour for each agent (the account default). More
  deliveries in one hour wait.
- From OpenBot v0.71.0 (upstream #7825), a hidden agent takes work: the automation server lists
  it, and it gets messages and routine runs. A wake therefore reaches a hidden agent. To keep a
  hidden agent from being woken, keep an explicit route for it whose routine is paused, or turn
  off "Local scripts" for it. A host before v0.71.0 refused a hidden agent with 409, and the
  route then waits in `agent_hidden` until a person restores the agent.

## Verify

```sh
sudo -u openbot cat ~openbot/.local/state/openbot-agent-relay/messaging-status.json
journalctl -u openbot-agent-relay-provision.service -n 20   # created/adopted counts and labels
sudo -H -u openbot python3 /opt/openbot-agent-relay/relay-messaging.py sync
```

All agents are ready when `state` is `ready` and `profiles`, `registered`, `verified` and
`heartbeats` have the same value, with `failed` at 0. `sync` must show the same number in
`registered` and an empty `failed` list. For one agent:
`sudo -H -u openbot python3 /opt/openbot-agent-relay/relay-messaging.py --bot <agent-id> whoami`.

Check that the key is not readable by the agents: `sudo -u openbot cat
/etc/openbot-agent-relay/workspace-key` must fail.

Check wake: each agent's route must be `connected` in
`~openbot/.local/state/openbot-agent-relay/wake/status.json`. After a relay message to an agent,
its route shows `accepted` one higher and the delivery ID in `lastDeliveryId`.

## Recover

| Label | Meaning | Action |
| --- | --- | --- |
| `provisioner_unavailable` | No provisioner socket. | Start the provisioner unit. Look at its journal. |
| `relay_workspace_mismatch` | The key is for another workspace. | Write the correct key, restart the provisioner. |
| `relay_authentication_failed` | The relay refused the key. | Write a valid key, restart the provisioner. |
| `identity_conflict` | The relay name belongs to another server or agent. | The owner decides. The provisioner never takes over. |
| `recovery_required` | The relay has this agent, but this server has no token for it. | Owner decision, then `recover` (below). |
| `identity_removed` | This server has a token, but the relay has no agent. | The owner decides. To make a new identity, remove the agent's entry from the credentials file (stop the messaging service first). |
| `registered_bot_name_changed` | The agent was renamed in OpenBot. | A rename needs an explicit identity migration. |
| `heartbeat_<label>` | A heartbeat failed. | Look at the label; the other agents continue. |

### Recover an agent with `recovery_required`

The relay has no API to issue an agent token again. If this server lost the token of an agent,
for example because a create answer did not arrive, first look for a saved credentials file that
has the token. If there is none, the only recovery is to delete the agent at the relay. The next
messaging cycle then creates it again.

**This step is destructive.** The agent gets a new id, a new token and a new address. Its pending
deliveries are lost. Peers that saved the old address must use the new one. Get the owner's
decision first.

1. Read what would be deleted (dry run, no change):

   ```sh
   python3 /opt/openbot-agent-relay/relay-provision.py recover \
     --relay-name openbot-<server>-<agent> --key-file /etc/openbot-agent-relay/workspace-key
   ```

   It prints the agent id, the OpenBot agent id, `createdAt` and the number of pending deliveries.
   It refuses when it does not run as root, when the key file is not root-owned with mode 0600,
   when the key is for another workspace, when the name is outside this server's prefix, or when
   the record's `openbot_server_id` is not this server.
2. If the credentials file has an entry for this agent, stop the messaging service and remove
   that entry. An agent with `recovery_required` normally has no entry.
3. Run the same command with `--apply`. It sends `DELETE /v1/agents/<name>`.
4. Start or restart the messaging service. Check that the agent is in `registered` and
   `verified`. Then restart the wake listener so that it uses the new token.

## Roll back

1. `systemctl disable --now openbot-agent-relay-provision.service`.
2. For each path in `<backup-dir>/manifest.json`: copy each `replaced` file back from the backup
   folder, and remove each `created` file. Then `systemctl daemon-reload`.
3. Restart the messaging, identity, history and wake units.
4. Optional: `shred -u /etc/openbot-agent-relay/workspace-key`, and `userdel openbot-relay` if
   the manifest lists it in `usersCreated`.

The credentials file keeps its format, so the old helpers can read it. Agents that the provisioner
created stay at the relay. The old helpers need the deleted bridge, so after a roll back the
messaging service reports `waiting` again.

## Network namespace

`scripts/hosting/egress/openbot-egress.py attach` puts the messaging and wake units in the egress
namespace. It does not include the provisioner, because `attach` requires the OpenBot service
user for each Agent Relay unit. The provisioner uses the host network.

## Owner tasks

- Get the workspace key through the Agent Relay Cloud device sign-in and the workspace `resolve`
  endpoint, and write it to the server as root (Install step 4).
- Give the config values: `relayWorkspaceId`, and optional `cloud_workspace_id` and `owner_hash`.
- Decide each `recovery_required` case before a `recover --apply`, and each `identity_conflict`
  and `identity_removed` case.
- Decide if the provisioner must also use the egress namespace.
- Turn on "Local scripts" in the settings of each agent that must be woken through a `message`
  route. On a joined server this is a setting of each agent; the account default does not apply.
