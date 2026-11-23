# Desktop fork updates

The fork's `main` branch contains the Electron desktop application. The earlier default branch
used a different application; the reconciliation kept that history as a parent. GitHub redirects
`kareem717/OpenBot` to `fundlevel-digital/openbot`. Keep the desktop update feed separate from
upstream releases. Keep the current worktree branch name during an upgrade.

## Release addresses

| Address | Purpose |
| --- | --- |
| `desktop-v<version>` GitHub release | Immutable desktop packages and their manifests |
| `desktop-latest` GitHub release | Moving Linux update manifest only |
| Repository-wide latest release | The other application; the desktop branch does not read or change it |

The installed desktop package uses the generic feed at
`https://github.com/kareem717/OpenBot/releases/download/desktop-latest/`. The Linux installer,
hosted updater, and release status check use that same feed. A manifest names its complete,
versioned download address, for example
`https://github.com/kareem717/OpenBot/releases/download/desktop-v0.60.1/OpenBot-0.60.1-x86_64.AppImage`.

The publisher uploads the immutable packages first. It advances the moving manifest only after
both native builds pass and the package hashes match. A failed or interrupted download therefore
keeps referring to the same immutable package. A feed promotion rejects an older version or changed
contents for a version already published. Both kinds of desktop release use `--prerelease --latest=false`. Their numeric app versions
remain normal update versions because the desktop reads the explicit generic feed.

## Build and check

A push to `main`, `codex/remove-capacity-limits`, or `conductor/latest-version-upgrade` runs
`.github/workflows/desktop-fork.yml`. The workflow also supports a manual run. It checks the affected
TypeScript projects, runs the real-service capacity and feed checks, and builds these artifacts:

- `desktop-linux-x64`: the self-hosted server AppImage and Linux update manifest.
- `desktop-macos-arm64`: the local-install client ZIP, DMG, and manifest.

These branch builds are GitHub Actions artifacts. They publish no GitHub release and change no
installed application. Package checks run the packaged application, check its resources, update
source, archive integrity, and Electron sandbox fuses. Builds use the repository's pinned Node and
Bun versions and its existing native-runtime preparation scripts.

Keep focused checks local. Full native builds run in GitHub Actions.

## Install the checked build

Download both artifacts from the same successful workflow run. The server and client both need
the capacity changes: an older client can still reject the larger list or disable its controls.

On a Linux server, verify the AppImage against its `latest-linux.yml` SHA-512 before extracting it.
The initial fork build can have the same version as the installed upstream build. Extract it into
a temporary directory, then run its `resources/hosting/openbot-server-setup` script as root. That
script preserves the existing service user, data directory, account-service override, and display
size. It refuses a lower version. Stop and start the service through that setup script; do not
replace `app.asar` under a running process.

For an extracted and verified build in `squashfs-root`, the initial install command is:

```sh
sudo bash "$PWD/squashfs-root/resources/hosting/openbot-server-setup" "" "$PWD/squashfs-root"
```

On an Apple silicon Mac, quit OpenBot and install the checked DMG's complete application bundle.
Keep the existing application-data folder. This client is unsigned for distribution and is not
notarized. The operating system can require the user to allow its first launch. Do not edit the
archive of the upstream signed application: that breaks its archive integrity and signature.

The unsigned Mac client is a manual installation. The publisher does not place `latest-mac.yml`
on the moving feed. A signed, notarized Mac release and its signing verification are required
before automatic Mac updates can be offered. Until then, install the checked client artifact for
each desktop release. The fork client does not fall back to the upstream update feed.

## Publish an update

Before a version change or tag, complete the repository's release-upgrade-safety audit. Keep the
application version numeric `x.y.z`; hosted installation does not accept a prerelease suffix.
Never deploy an older source schema over a database opened by a newer release.

After review and verification, push a tag named `desktop-v<package.json version>` on the desktop
branch commit. The same workflow builds both native artifacts. Its publish job then creates that
namespaced release and advances the isolated Linux feed. Versioned release contents cannot be
replaced. Re-running a failed publish job can reuse them only when its checksum list is identical.

After the first fork release is installed, the server's existing update timer and update command
download only the fork feed. Each new package carries the fork's updater and install scripts, so
an update retains that source. The source changes are Git commits on the desktop branch, not a
local archive patch.

## Bring in upstream changes

Keep desktop fixes as source commits on the desktop branch. Do not patch installed archives or
store fixes only in an agent's workspace instructions. A full package update must contain the same
source changes as its tag.

After an upstream merge or rebase, keep these checks in `desktop-fork.yml`:

- `scripts/plan-continuation-e2e.ts`: upstream's continuation rules, plus the fork's human-handoff
  pauses: no continuation while a person must act, answer, sign in or approve.
- `scripts/browser-user-control-e2e.ts`: tab-list and status reads return while a person holds a
  tab; page reads and mutations still wait.
- `bun run test:browser-cdp`: attach the real `agent-browser` CLI to the existing tab, keep its
  session, limit target access, redact secrets, and revoke external access for user control.
- `scripts/browser-smoke.ts --scenario=secret-handoff`: saved password and authenticator fills,
  with upstream's code-field rule (#8524) and the fork's split code group rule. A `Digit N` group
  with no authenticator text stays refused. A Vault code goes one digit to each box of an accepted
  group, and a GET form of the boxes cannot send the code in its URL.
- `scripts/browser-otp-fields-e2e.ts`: the code-field rule and the split code group rule on the
  real engine: accepted and refused groups, one digit for each box, and the entry check of a group
  that changed after the fill request.
- `scripts/browser-native-control-e2e.ts`: use real OS input in the same tab between CDP sessions;
  keep the document and sign-in, exclude CDP during native control, and preserve permission gates.
- `scripts/browser-native-task-permission-e2e.ts`: allow an enabled agent's task to use its own
  native browser, keep general desktop MCP tools out of tasks, and honor parent permission revocation.
- `bun run test:browser-steps`: a bot check's `click-once` offer stays until an agent click lands
  in the check widget. A second snapshot, the final snapshot of a `run_script`, or a click elsewhere
  on the page keeps the offer. After the click, a check that stays asks for a person, and a new
  document gets a new offer. Upstream (checked on `upstream/main`) uses the offer on the first read
  after it, also with no click.

Resolve conflicts in the owning source modules and keep these behavior checks. Preserve the
credential-source instructions in `agent/developer-instructions.ts` and `agent/tool-guidance.ts`:
user-supplied file or API credentials can be read and entered by a local script without printing
their values. A successful rebase alone does not verify that these behaviors remain.
Keep the native control port, private driver display selection, and CDP lease exclusion together.
On a server, the browser and general Computer Use can use different displays; the native browser
driver must use Electron's display and must not be published as a general provider MCP server.

Fetch the required `nightly-labs/openbot` release and merge it into the desktop branch. Preserve
the capacity changes and the isolated feed addresses. Resolve conflicts in source, run the branch
workflow, and complete the upgrade audit before publishing the next numeric desktop version.
Do not point this branch at upstream's automatic update feed or publish desktop packages under
upstream version tags.

## Fork patches replaced by upstream

On 2026-11-16 the owner decided to use upstream's version of these fork patches after the v0.71.0
merge (rule "Upstream overlap check" in `AGENTS.md`). The branch no longer has the fork patch.

- The saved Cursor API key of the first account (`cursor-api-key-v1`, fork commit `33370f72c5`).
  Upstream #8843 adds each Cursor account after the first from an API key. A host or client that
  still names `cursor-api-key-v1` is not refused: the host ignores an unknown capability, and a
  client accepts any capability name that a host lists.
- The fork's next-step continuation rule (fork commits `e312fa5112`, `aea44dc452`): extra "I'll
  retrieve ..." and "I'm fetching ..." phrases, and a commentary-only progress message read as the
  turn's answer. Upstream's rules (#8393 status and Portuguese next steps, #8837 Codex narration
  answer) apply. The fork's human-handoff pauses (`7f3ef1500b`) and MCP sign-in pause stay.
- Authenticator codes for numeric fields only (fork commit `bd2541951b` and the labelled numeric rule
  before it). Upstream's rule (#8524) applies: a text, tel or number field whose id, name, label,
  aria label, placeholder or title has a code word, or a "code" field in a form that names an
  authenticator app, takes a vault code. The fork's check that a field is visible stays.

## Split authenticator code group

A fork patch on top of upstream's code-field rule (#8524). On 2026-11-16 the owner chose upstream's
per-field rule (see above). That rule does not change. Upstream refuses a split code group, so a
bank sign-in with six boxes named "1 digit" to "6 digit" needed a person to type the code.

The fork adds a second way for an authenticator code to fill from the Vault with no person:
`SPLIT_CODE_GROUP_FUNCTION` in `src/backend/browser-cdp.ts`. The host asks for it only for
`method=authenticator` with one target for each digit and 6 to 8 digits. All of these must be true:

- The step comes right after a saved password. A Vault password entry records its origin and time on
  the tab (`BrowserHostTab.vaultPasswordFill`). The record must have the same origin and be at most
  5 minutes old (`SPLIT_CODE_AFTER_PASSWORD_MS`). The submit of a code that the group rule accepted
  deletes it, also when the fill fails, so a later group in the session, such as a payment step-up,
  goes to the card. A main-frame navigation to another origin deletes it, an idle unload keeps it, and
  it closes with the tab. The per-field rule does not use it.
- Each box is an enabled, editable, visible text, tel or number input with no mask.
- Each box takes one character: `maxlength="1"`, or no `maxlength` and at most 72 CSS px wide. A box
  whose `maxlength` is the number of boxes also passes when it is at most 72 CSS px wide, because it
  also takes the whole code from a paste or code autofill. This can be any box. The bank page has
  `maxlength="6"` on its first box only. The widths are equal within 2 px. The boxes are in one row in target order (reverse for `rtl`).
- Each box has its own ordinal name for its position, such as "Digit 3", "Digit 3 of 6" or "3 digit",
  in its aria-label, a label, an aria-labelledby text, its placeholder or its title. The per-field
  rule's exclusion words refuse the box.
- The container is the first ancestor of the boxes (the body at most) whose visible text names an
  authenticator app. It and each ancestor below it have only the boxes as visible text-entry controls
  and at most 600 characters of text. Its text has no email, SMS, text message, phone, WhatsApp or
  voice call word.
- When a box is in a form, all boxes are in that form, its other controls take no text (also controls
  joined with `form=`), and no named, enabled control is between the first and the last box.
- The visible text of the whole body is at most 3,000 characters and has no PIN, card reader,
  memorable, security number, pay, payment, payee, transfer, beneficiary, amount, send money, approve,
  authorise, transaction, withdraw or wire word.

The fingerprint does not change. Entry runs the same function again before the first digit, and
a false result enters nothing and ends in takeover. During a Vault fill of a code in digit boxes, the
host also blocks a URL whose query and fragment values, joined in order, contain the code. The rule
that no named control is between the boxes keeps a GET form from splitting those values.

Checks: `scripts/browser-otp-fields-e2e.ts` and `scripts/browser-smoke.ts --scenario=secret-handoff`.
At the next upstream merge, keep the patch while upstream refuses a split code group. Upstream's
smoke expects the `Digit N` group of its `/login` fixture to be refused; the fork keeps that
expectation, because that row names no authenticator app and the body has other text inputs.

## Upstream fixes taken before a merge

On 2026-11-18 these browser tab fixes came from `upstream/main` by `git cherry-pick -x`, before the
next upstream merge. A server unloaded no hidden agent tab that played muted media, such as YouTube.
Each commit message names its upstream commit.

| Upstream commit | PR | Change |
| --- | --- | --- |
| `f15f980c88` | #10363 | An idle unload releases the evaluate mark of the tab |
| `8461760ee9` | #10376 | The end of a secure sign-in card frees the tab |
| `abf6ac60bc` | #10450 | Muted media is not a use, so a hidden tab that plays it pauses and unloads |
| `662dd982ea` | #11631 | The idle unload skips a tab while its first page loads |
| `07b5e99673` | #11647 | An action timeout on a page that does not answer frees the tab |
| `d09e63d9c9` | #12083 | A close of a tab that an earlier operation blocks ends |

At the next upstream merge, upstream's side is the source of truth for these changes. Git can show
conflicts in `src/backend/browser-host.ts`, `src/backend/browser-tab-operations.ts` and
`scripts/browser-secret-smoke.ts`. Take upstream's version of these hunks, and keep the fork code
in the same files: the native control tab, external CDP and the `click-once` offer.

Exception: the fork frees a tab at once when a failed fill leaves no value in the page (fork commit
`3290aca164`). Upstream's #10376 smoke expects that tab to stay protected. Fork commit `1f8bea30ff`
changes the `/lost` page and the `after-fill` and `held` cases so that the tab stays protected in
the fork. Keep that change while the fork keeps `3290aca164`.

## Known exceptions

- Channel routines: from upstream v0.71.0 (#6077), a scheduled tick does not start a run while an
  earlier run of the same routine has a task that is not completed or cancelled. A resumed run, such
  as one that stopped for a provider billing failure, therefore blocks later ticks of that routine
  until it ends. The fork's billing check in `channel-routine-scheduler.ts` runs before that rule.
  It is now redundant, because a paused task is also not finished, but it is kept.
  `scripts/cursor-payment-required-e2e.ts` checks both.
- Released English text: before the v0.71.0 merge, the fork changed the English text of the released
  key `error.provider.codexOutdated` (minimum Codex version 0.156.0 to 0.166.0). The i18n rule says
  that released English stays the same byte for byte, because remote clients and older versions read
  it. The v0.71.0 merge does not change it. The owner is informed.

## Recover a queued Mac build

For `desktop-v0.60.12`, the recovery workflow uses a standard macOS 15 ARM64 runner.
It checks out the exact release tag and requires source commit
`01d437758958c87fabec92bfc5162c4f4e219a3a` before building. It keeps the package, launch,
runtime, archive and manifest checks. The artifact includes `recovery-source.json`.
The workflow uploads artifacts only. If recovery supplies the Mac package, record both the
Linux/source workflow and the recovery workflow in the release evidence before publication.
Use the tagged metadata tools; do not copy tools from a later branch into this build.

The initial recovery built the exact `desktop-v0.60.1` source
on a standard macOS 26 ARM64 runner. It checked the source commit before building.
The packaged app then passed the same archive, fuse, runtime, and launch checks.
After that build, the workflow applied the branch's corrected manifest tooling:
macOS manifests contain both ZIP and DMG entries, each with a verified digest.
This changes release metadata tooling only. The tagged application source stays
the source of the package. Failed runs retain diagnostic packages separately.

The original Linux package and the recovered Mac package can form one release
only after both native package checks pass and their source commit matches.
Record both run links in the release notes, verify all hashes, and use the same
immutable-payload and monotonic-feed checks as the normal publisher. The normal
workflow also uses macOS 26 for later releases.

The initial `desktop-latest` tag is bootstrapped with the maintainer's GitHub access.
A workflow token can upload a release for an existing tag but can lack permission
to create this first tag from a branch that changes workflow files. Later releases
reuse that feed tag and replace only its Linux manifest.

## A phone cannot connect to the server

The mobile app shows "Reconnecting" for the server and tries again without end. Its Support log
(Settings > Support > Support log) shows `[webrtc/ice/failed]` after an answer that came quickly.
The host logs no error.

Check the network route of the host first. The file
`openbot-remote-network-route-v1.json` in the host's data directory holds it:

- `{"version":1,"route":"private"}`: devices connect only over a private network, such as Tailscale
  or the LAN. The host uses no STUN or TURN server and drops all public candidates. A device that is
  not on that network cannot connect. A desktop on the tailnet connects, so the server looks correct.
- `{"version":1,"route":"openbot"}`: devices connect from all networks through STUN and TURN. This
  is the default.

To fix the connection, put the device on the private network, or change the route to `openbot`.
The route is a local setting with no Team API route. On a server with no window:

1. Make sure that no agent turn runs. A restart stops it.
2. Stop `openbot.service`.
3. Keep a copy of the file, then write the new route to it as the service user.
4. Start `openbot.service`. The host reads the route when it connects to Signal.

A slow host is a different fault. If the Support log shows `[timeout/connect/...]`, or a desktop
needs 20 seconds or more to open its channels, restart `openbot.service`. Upstream commit
`4c8d48d7c0` ("Keep a host answering devices when one device's setup stops") changes this area.
The fork has it from the v0.71.0 merge. It is not confirmed that it fixes this fault.

## Upgrade from 0.71.0 to 0.77.0

Use the published `v0.77.0` tag as the upstream input. Keep the fork additions. The owner directed
this on 2026-11-23, including the Cursor billing pause. Upstream #10573 detects the Cursor
payment-method message as a plan limit; its chunk detector must not take precedence over the
fork's billing result.

Upstream protocol 10 has a frozen baseline of 256 official capabilities. Keep that baseline
unchanged. Carry the five extra fork capabilities as explicit protocol 10 extensions, and project
older protocol lists to their released limits while keeping the fork capabilities of a fork peer.
Do not put extra names in the official baseline fixture.

Upstream moves memory controls into `ServerMemorySection` and MCP controls into the marketplace.
Keep the unlimited-memory gate and paged requests in those new owners. Retain the fork's thread
cards and question context while using upstream's current message and settings APIs.

Schema versions 62 through 69 run at startup. The old 0.71.0 application refuses schema 69.
An old package can recover an activation failure only before the database migrates. After migration,
use a forward repair. Never reset or remove a user's database to start an old package.

Check schema parity and released-schema data preservation, then the affected fork E2E scripts.
Build and verify both native packages in CI. Preserve hosted service overrides, the network namespace,
Agent Relay services, and the Mac application-data directory during installation.

Focused checks for this merge passed: schema parity (4), released-schema upgrades (131), database (92), secret redaction (71), IPC coverage (14), authenticated browser-view permissions (3), protocol 10, legacy clients, 38,904 wire comparisons, split-code fields, versioned JSON stores, account-session files, history review (14), and the Node and renderer type projects. The commit hook repeats the required staged checks. Native packages and installed runtime checks remain part of completion.

The merge-resolution lint check retains two upstream `noConfusingVoidType` warnings in `channel-service.ts`. The `void` types describe Effect operations that return no value. Replacing them with `undefined` only to silence the warnings would change those operation contracts.

The Cursor billing E2E passed after excluding the payment-method text from upstream's plan-limit chunk detector. The complete-answer detector still requires the exact billing answer. Split chunks are classified as billing; quoted phrases and JSON remain answers. The routine resumes after billing is fixed, and later scheduled runs start normally.
