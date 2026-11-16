### Changed

- Bring in upstream v0.71.0 and keep the additions of this branch: no capacity limits, paged MCP
  server, skill and channel memory lists, native browser control, hosted egress, chunked JSON
  replies, channel routing clarification and the isolated update feed.
- A saved authenticator code still goes only to a numeric code field. Upstream v0.71.0 also fills a
  text field that its label or form names as an authenticator code, such as on Okta; this branch
  does not.

- A Codex turn that ends with narration after its last step and an empty answer shows that
  narration as its answer, as in upstream v0.71.0. A turn that ends after a progress message
  before its last step still continues the work that the message names, as before on this branch.

### Removed

- Cursor: the first Cursor account can no longer sign in with only a Cursor API key that you save in
  OpenBot. A key that you saved before is not used. To use a Cursor API key, add it as a Cursor
  account in the provider settings, as upstream v0.71.0 does. The first account signs in with the
  browser sign-in or with `CURSOR_API_KEY` in your environment. A joined server no longer offers the
  Cursor key setting of this branch.

### Fixed

- The paged MCP server list of a joined server now hides the servers that a member cannot see, and
  their sign-in states, as the other MCP routes do from upstream v0.71.0.
