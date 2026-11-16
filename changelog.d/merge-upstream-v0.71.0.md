### Changed

- Bring in upstream v0.71.0 and keep the additions of this branch: no capacity limits, paged MCP
  server, skill and channel memory lists, native browser control, the saved Cursor API key, hosted
  egress, chunked JSON replies, channel routing clarification and the isolated update feed.
- A saved authenticator code still goes only to a numeric code field. Upstream v0.71.0 also fills a
  text field that its label or form names as an authenticator code, such as on Okta; this branch
  does not.
- The saved Cursor API key applies to the first Cursor account only. An added Cursor account uses
  its own key, as upstream v0.71.0 adds.

### Fixed

- The paged MCP server list of a joined server now hides the servers that a member cannot see, and
  their sign-in states, as the other MCP routes do from upstream v0.71.0.
