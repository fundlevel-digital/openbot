### Added

- Hosted servers: optional Agent Relay helpers in `scripts/hosting/agent-relay`. Each agent on the
  server gets its own relay identity from a local provisioner, so no bridge service is necessary,
  and the relay workspace key stays out of reach of the agents. An agent is woken when a relay
  message arrives for it. See `docs/openbot-agent-relay.md`.
- **To wake an agent through the new message route, turn on "Local scripts" in that agent's settings.**
- Hosted servers with Agent Relay: a session that an agent starts in its own workspace folder, such as
  a side run, now carries the relay name of that agent in the uploaded history. Before, only the
  agent's own conversations had the name.
