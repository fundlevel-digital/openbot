### Changed

- Upgrade the desktop fork to OpenBot 0.77.0. **The server and the Mac client must both use the new build.** Older hosts keep their supported protocols and capabilities.
- Keep the fork's capacity and memory policies, paged skill and MCP lists, large WebRTC responses, native browser and CDP control, WebMCP, split authenticator fields, protected credential entry, channel routing and routine priority, history-review checkpoints, thread cards and attention, and hosted Agent Relay helpers.
- Keep the Cursor billing pause when it asks for a payment method. The request does not start a model fallback or repeated routine attempt.
- Keep the extra fork capabilities available to older fork clients within their list limit, and add them to protocol 10 without changing its official frozen baseline.
- Preserve stored tabs, routines, drafts and conversations. Upstream replaces the old browser and file panel widths and sidebar agents/routines toggle; these three display choices do not carry forward.
- Migrate database schema 61 through 69 at startup. **Version 0.71.0 cannot reopen the database after this upgrade.** An activation failure before migration can use the previous package. After migration, repair forward; do not reset user data.

### Fixed

- Keep unlimited-memory controls and paged MCP access after the Server Settings and marketplace changes.
- Keep bounded secret-matching batches with public model names and chat-post redaction, so a large saved-secret list does not exhaust the regular-expression compiler.
- Keep question context and action cards in side threads without duplicate narration, and keep the correct state of a replaced plan.
