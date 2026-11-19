### Changed

- Bring in upstream v0.73.0 and keep the additions of this branch: no capacity limits, paged MCP
  server, skill and channel memory lists, native browser control, the split authenticator code
  group, the saved browser tabs at start, and the isolated update feed.
- Authenticator codes: digit boxes in a frame, and a sign-in form that asks for the password and
  the code together, never count as a split code group. Such a form gets the password and the code
  from one saved login, as in upstream v0.73.0.
- Cursor: the answer "Add a payment method to continue" now shows that the Cursor plan is used up,
  as in upstream v0.73.0. Before, this branch showed that the provider needs a payment method.

### Fixed

- Agents no longer ask again for a key that the user pasted: they save it, as in upstream. The agent
  guidance no longer names `ask_ui` forms and lists that no longer exist, and its browser rules are
  shorter.
- Global search no longer shows the memory limit of a server with unlimited memory storage. Server
  settings also hide the limit there after upstream moved it to the Memory section.
