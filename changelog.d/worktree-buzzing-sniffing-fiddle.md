### Added

- Hosted servers: optional Agent Relay helpers in `scripts/hosting/agent-relay`. Each agent on the
  server gets its own relay identity from a local provisioner, so no bridge service is necessary,
  and the relay workspace key stays out of reach of the agents. An agent is woken when a relay
  message arrives for it. See `docs/openbot-agent-relay.md`.
- **To wake an agent through the new message route, turn on "Local scripts" in that agent's settings.**
- Hosted servers with Agent Relay: a session that an agent starts in its own workspace folder, such as
  a side run, now carries the relay name of that agent in the uploaded history. Before, only the
  agent's own conversations had the name.
- Servers: a host can start each new agent on a named browser profile, such as a profile with a
  proxy, in place of Shared. Write `openbot-new-agent-browser-profile-v1.json` in the user-data
  folder; it needs no restart, and existing agents keep their profile. See
  `docs/architecture/browser.md#browser-profile-of-a-new-agent-fork-only`.
