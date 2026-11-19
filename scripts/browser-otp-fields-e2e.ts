// Drives the real secure-field detector and entry guard in an isolated Electron browser. The code
// field rule is upstream's (#8524): a text, tel or number field whose id, name, label, aria label or
// placeholder has a code word, and no backup, name, label, card, postal or similar word. The fork adds
// a split code group rule: 6 to 8 one-character boxes with ordinal names, in a container that names an
// authenticator app and has no other text input. A narrow box can also take the whole code. Entry
// checks the group again.
// Run: bun scripts/browser-otp-fields-e2e.ts [--baseline]
// Report: .openbot-build/browser-otp-fields-e2e/report.json
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { BrowserCdpEngine } from "../src/backend/browser-cdp";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

const ORIGIN = "https://authentication.openbot.test";
const CODE = "953174";
const BASELINE = process.argv.includes("--baseline");
interface FixtureReport {
  passed: boolean;
  baseline: boolean;
  electron: string | undefined;
  checks: string[];
  elapsedMs: number;
  error: string;
}
const PAGE = `<!doctype html><meta charset="utf-8"><title>Authentication fixture</title>
<input id="verificationCode" inputmode="numeric" autocomplete="off" maxlength="6">
<label id="label" for="labelled">Authenticator code</label><input id="labelled" type="tel" autocomplete="off">
<span id="aria-label">Authentication code</span><span id="other-label">Postal code</span>
<input id="aria" aria-labelledby="aria-label" type="tel">
<label>One-time passcode<input id="wrapped" inputmode="numeric"></label>
<input id="placeholder" placeholder="Verification code" inputmode="numeric">
<input id="ius-mfa-token" type="tel" maxlength="6">
<input id="marked" autocomplete="one-time-code">
<input id="cardVerificationCode" inputmode="numeric" maxlength="3">
<input id="cvc" aria-label="Security code" inputmode="numeric" maxlength="3">
<input id="postalVerificationCode" inputmode="numeric">
<input id="ordinary" inputmode="numeric">
<input id="otp-text">
<input id="payment" inputmode="numeric" aria-label="Authenticator code" autocomplete="cc-csc">
<label for="other">Authenticator code</label><input id="other"><input id="unlabelled" inputmode="numeric">
<input id="disabled-otp" type="tel" disabled>
<input id="readonly-otp" type="tel" readonly>
<input id="hidden-otp" type="hidden">
<label for="invisible">Authenticator code</label><input id="invisible" type="tel" style="display:none">
<script>window.trustedInputs = 0; addEventListener('input', event => { if (event.isTrusted) window.trustedInputs++; });</script>`;

// The fork's split authenticator code group: a bank sign-in shows six boxes named "1 digit" to "6 digit",
// with the authenticator text two levels above their row and no form.
const BANK_TEXT =
  "<p>To verify it's you, enter a code from your authenticator app</p><p>Check your Authenticator app</p>";
interface GroupOptions {
  count?: number;
  cell?: (index: number, count: number) => string;
  text?: string;
  form?: boolean;
  /** Attributes of the form, such as `method="get"`. */
  formAttributes?: string;
  extra?: string;
  style?: string;
  /** HTML above the container, in the same `main` element. */
  before?: string;
  /** HTML after the `main` element, in the body. */
  after?: string;
}
function groupPage({
  count = 6,
  cell = (index) => `<input id="box-${index}" aria-label="${index + 1} digit">`,
  text = BANK_TEXT,
  form = false,
  formAttributes = "",
  extra = "",
  style = "",
  before = "",
  after = "",
}: GroupOptions = {}): string {
  const tag = form ? "form" : "div";
  const cells = Array.from({ length: count }, (_, index) => `<div class="cell">${cell(index, count)}</div>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>Code group fixture</title>
<style>.row{display:flex;gap:8px}.cell input{width:40px;height:48px}${style}</style>
<main>${before}<${tag} id="container" ${form ? formAttributes : ""}><h2>Two-step verification</h2>${text}<div class="group"><div class="row" id="row">${cells}</div></div>${extra}
<button type="button" id="back">Back</button><button type="button" id="continue">Continue</button></${tag}>
<footer><a href="#privacy">Privacy</a> <a href="#security">Security</a> <a href="#help">Help</a></footer></main>${after}
<script>window.trustedInputs = 0; addEventListener('input', event => { if (event.isTrusted) window.trustedInputs++; });</script>`;
}
const ariaCell =
  (labels: number[], attributes = "") =>
  (index: number) =>
    `<input id="box-${index}" aria-label="${labels[index]} digit" ${attributes}>`;
// A copy of the real bank page, as its owner read it: no form, no ids, and the first box also takes the
// whole code from a paste or code autofill. The row has no text; the div above it names the app.
const REAL_BANK_PAGE = `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<style>.boxes{display:flex;gap:8px}.boxes input{box-sizing:border-box;width:66px;height:56px}</style>
<header>Online Banking</header>
<div><h2>Check your Authenticator app</h2><p>To verify it's you, enter a code from your authenticator app</p><div class="boxes">${Array.from(
  { length: 6 },
  (_, index) =>
    `<input type="tel" inputmode="numeric" name="token-input-${index + 1}" aria-label="${index + 1} digit" ${index === 0 ? 'maxlength="6" autocomplete="one-time-code"' : 'maxlength="1" autocomplete="off"'}>`,
).join("")}</div><button type="button">Back</button><button type="button">Continue</button></div>
<footer>Privacy Terms Help</footer>
<textarea class="g-recaptcha-response" style="display:none"></textarea>
<iframe title="reCAPTCHA" src="about:blank" width="256" height="60"></iframe>
<script>window.trustedInputs = 0; addEventListener('input', event => { if (event.isTrusted) window.trustedInputs++; });</script>`;
/** The first box of a whole-code case takes the length of the code. */
const wholeCodeCell = (maxLength: number) => (index: number) =>
  ariaCell([1, 2, 3, 4, 5, 6], index === 0 ? `maxlength="${maxLength}"` : 'maxlength="1"')(index);
/**
 * Each case: the page, the number of boxes that the agent names, whether the group rule accepts, and
 * the CSS selector of each box (from 0) when the boxes have no id.
 */
const GROUPS: Record<string, { page: string; targets: number; accepted: boolean; box?: (index: number) => string }> = {
  bank: { page: groupPage(), targets: 6, accepted: true },
  form: { page: groupPage({ form: true }), targets: 6, accepted: true },
  labels: {
    page: groupPage({
      cell: (index, count) =>
        `<label for="box-${index}">Digit ${index + 1} of ${count}</label><input id="box-${index}" maxlength="1">`,
    }),
    targets: 6,
    accepted: true,
  },
  eight: {
    page: groupPage({
      count: 8,
      cell: (index, count) => `<input id="box-${index}" type="tel" aria-label="Character ${index + 1} of ${count}">`,
    }),
    targets: 8,
    accepted: true,
  },
  email: {
    page: groupPage({ text: "<p>Enter the code that we emailed to you, or a code from your authenticator app</p>" }),
    targets: 6,
    accepted: false,
  },
  sms: {
    page: groupPage({ text: "<p>Enter the code from the SMS that we sent, or from your authenticator app</p>" }),
    targets: 6,
    accepted: false,
  },
  "text-message": {
    page: groupPage({ text: "<p>Enter the code from the text message, or from your authenticator app</p>" }),
    targets: 6,
    accepted: false,
  },
  "no-authenticator": { page: groupPage({ text: "<p>Enter your verification code</p>" }), targets: 6, accepted: false },
  "hidden-authenticator": {
    page: groupPage({ text: "<p>Enter your verification code</p><p hidden>Use your authenticator app</p>" }),
    targets: 6,
    accepted: false,
  },
  "other-input": {
    page: groupPage({ extra: '<input id="other" type="text" aria-label="Comment">' }),
    targets: 6,
    accepted: false,
  },
  textarea: { page: groupPage({ extra: '<textarea id="note"></textarea>' }), targets: 6, accepted: false },
  "seventh-box": { page: groupPage({ count: 7 }), targets: 6, accepted: false },
  "out-of-order": { page: groupPage({ cell: ariaCell([1, 3, 2, 4, 5, 6]) }), targets: 6, accepted: false },
  gap: { page: groupPage({ cell: ariaCell([1, 2, 3, 5, 6, 7]) }), targets: 6, accepted: false },
  // The agent names 5 of 6 boxes: fewer than 6 targets.
  "count-5-of-6-boxes": { page: groupPage(), targets: 5, accepted: false },
  five: { page: groupPage({ count: 5 }), targets: 5, accepted: false },
  nine: { page: groupPage({ count: 9 }), targets: 9, accepted: false },
  masked: {
    page: groupPage({ extra: "<style>#box-2{-webkit-text-security:disc}</style>" }),
    targets: 6,
    accepted: false,
  },
  password: {
    page: groupPage({ cell: (index) => ariaCell([1, 2, 3, 4, 5, 6], index === 2 ? 'type="password"' : "")(index) }),
    targets: 6,
    accepted: false,
  },
  "maxlength-2": {
    page: groupPage({ cell: ariaCell([1, 2, 3, 4, 5, 6], 'maxlength="2"') }),
    targets: 6,
    accepted: false,
  },
  "real-bank": {
    page: REAL_BANK_PAGE,
    targets: 6,
    accepted: true,
    box: (index) => `input[name="token-input-${index + 1}"]`,
  },
  // Each box takes the whole code, so a paste works in each box.
  "maxlength-6-each": {
    page: groupPage({ cell: ariaCell([1, 2, 3, 4, 5, 6], 'maxlength="6"'), style: ".cell input{width:60px}" }),
    targets: 6,
    accepted: true,
  },
  "maxlength-6-wide": {
    page: groupPage({ cell: wholeCodeCell(6), style: ".cell input{width:120px}" }),
    targets: 6,
    accepted: false,
  },
  "maxlength-7-of-6": { page: groupPage({ cell: wholeCodeCell(7) }), targets: 6, accepted: false },
  wide: { page: groupPage({ style: ".cell input{width:100px}" }), targets: 6, accepted: false },
  "two-rows": {
    page: groupPage({ style: ".row{display:grid;grid-template-columns:repeat(3,48px)}" }),
    targets: 6,
    accepted: false,
  },
  unequal: { page: groupPage({ style: "#box-3{width:60px}" }), targets: 6, accepted: false },
  "excluded-name": {
    page: groupPage({ cell: (index) => ariaCell([1, 2, 3, 4, 5, 6], `name="smsDigit${index + 1}"`)(index) }),
    targets: 6,
    accepted: false,
  },
  payment: {
    page: groupPage({ text: "<p>Approve this payment with a code from your authenticator app</p>" }),
    targets: 6,
    accepted: false,
  },
  pin: {
    page: groupPage({ text: "<p>Enter your PIN or a code from your authenticator app</p>" }),
    targets: 6,
    accepted: false,
  },
  long: {
    page: groupPage({ text: `${BANK_TEXT}<p>${"Keep your account safe. ".repeat(30)}</p>` }),
    targets: 6,
    accepted: false,
  },
  "heading-above-form": {
    page: groupPage({
      form: true,
      before: "<h1>Use your authenticator app</h1>",
      text: "<p>Enter the 6-digit code</p>",
    }),
    targets: 6,
    accepted: true,
  },
  // reCAPTCHA adds a hidden textarea. The body is the container here.
  "hidden-textarea-body": {
    page: groupPage({
      text: "<p>Enter the 6-digit code</p>",
      after: '<p>Use your authenticator app</p><textarea style="display:none"></textarea>',
    }),
    targets: 6,
    accepted: true,
  },
  "payment-outside-container": {
    page: groupPage({ before: "<p>Review transfer: amount 5,000</p>" }),
    targets: 6,
    accepted: false,
  },
  "long-body": {
    page: groupPage({ after: `<p>${"Keep your account safe. ".repeat(140)}</p>` }),
    targets: 6,
    accepted: false,
  },
  "get-hidden-between": {
    page: groupPage({
      form: true,
      formAttributes: 'method="get" action="/next"',
      cell: (index) =>
        `${index === 3 ? '<input type="hidden" name="s" value="x">' : ""}<input id="box-${index}" name="d${index + 1}" aria-label="${index + 1} digit">`,
    }),
    targets: 6,
    accepted: false,
  },
  "get-hidden-outside": {
    page: groupPage({
      form: true,
      formAttributes: 'method="get" action="/next"',
      text: `${BANK_TEXT}<input type="hidden" name="state" value="x">`,
      extra: '<input type="hidden" name="nonce" value="y">',
      cell: (index) => `<input id="box-${index}" name="d${index + 1}" aria-label="${index + 1} digit">`,
    }),
    targets: 6,
    accepted: true,
  },
  "box-in-other-form": {
    page: groupPage({
      cell: (index) => ariaCell([1, 2, 3, 4, 5, 6], index === 3 ? 'form="elsewhere"' : "")(index),
      after: '<form id="elsewhere"></form>',
    }),
    targets: 6,
    accepted: false,
  },
  phone: {
    page: groupPage({ text: "<p>Enter a code from your authenticator app or your phone</p>" }),
    targets: 6,
    accepted: false,
  },
  // In a right-to-left row, the first box is on the right.
  rtl: { page: groupPage({ style: ".row{direction:rtl}" }), targets: 6, accepted: true },
  "rtl-left-to-right": {
    page: groupPage({ style: ".row{direction:rtl;flex-direction:row-reverse}" }),
    targets: 6,
    accepted: false,
  },
  // The per-field rule accepts these boxes, so the group rule, which refuses the SMS text, does not run.
  "one-time-code": {
    page: groupPage({
      cell: (index) => `<input id="box-${index}" autocomplete="one-time-code" maxlength="1">`,
      text: "<p>Enter the code from the SMS that we sent, or from your authenticator app</p>",
    }),
    targets: 6,
    accepted: false,
  },
};

if (process.argv.includes("--electron-worker")) await runWorker();
else await runHarness();

async function runHarness(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const output = join(root, ".openbot-build", "browser-otp-fields-e2e");
  await mkdir(output, { recursive: true });
  const fixture = await mkdtemp(join(output, "fixture-"));
  const bundle = join(fixture, "worker.mjs");
  const reportPath = join(output, BASELINE ? "baseline.json" : "report.json");
  try {
    const { build } = await import("bun");
    const built = await build({
      entrypoints: [fileURLToPath(import.meta.url)],
      target: "node",
      format: "esm",
      external: ["electron", "bun"],
      plugins: BASELINE
        ? [
            {
              name: "released-detector",
              setup(builder) {
                builder.onLoad({ filter: /\/src\/backend\/browser-cdp\.ts$/u }, () => ({
                  contents: execFileSync("git", ["show", "HEAD:src/backend/browser-cdp.ts"], { encoding: "utf8" }),
                  loader: "ts",
                }));
              },
            },
          ]
        : [],
    });
    assert.ok(built.success && built.outputs[0], "The browser fixture did not build.");
    await writeFile(bundle, await built.outputs[0].text());
    const electron = join(
      root,
      "node_modules",
      "electron",
      "dist",
      (await readFile(join(root, "node_modules", "electron", "path.txt"), "utf8")).trim(),
    );
    const launcher = join(fixture, "main.cjs");
    await writeFile(launcher, 'void import("./worker.mjs").catch(() => process.exit(1));\n');
    // CI blocks unprivileged user namespaces. This isolated fixture checks behavior, not the OS sandbox.
    const flags = process.platform === "linux" ? ["--no-sandbox"] : [];
    const child = spawn(
      electron,
      [...flags, launcher, "--electron-worker", `--fixture-root=${fixture}`, ...(BASELINE ? ["--baseline"] : [])],
      {
        env: withoutElectronRuntimeFlags(process.env),
        stdio: "ignore",
      },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    }).finally(() => clearTimeout(timer));
    const result: FixtureReport = JSON.parse(await readFile(join(fixture, "worker-report.json"), "utf8"));
    const passed = exitCode === 0 && result.passed === true;
    await writeFile(reportPath, `${JSON.stringify({ ...result, passed, exitCode }, null, 2)}\n`);
    process.stdout.write(`${passed ? "PASS" : "FAIL"}: ${reportPath}\n`);
    if (!passed) process.exitCode = 1;
  } catch (cause) {
    await writeFile(
      reportPath,
      `${JSON.stringify({ passed: false, error: cause instanceof Error ? cause.message : "The browser fixture failed." }, null, 2)}\n`,
    );
    process.stdout.write(`FAIL: ${reportPath}\n`);
    process.exitCode = 1;
  }
}

async function runWorker(): Promise<void> {
  const argument = process.argv.find((value) => value.startsWith("--fixture-root="));
  assert.ok(argument, "The browser fixture directory is missing.");
  const fixture = argument.slice("--fixture-root=".length);
  const profile = join(fixture, "profile");
  await mkdir(profile, { recursive: true });
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.disableHardwareAcceleration();
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.webContents.session.protocol.handle("https", (request) => {
    const url = new URL(request.url);
    const group = url.pathname.startsWith("/group/") ? GROUPS[url.pathname.slice("/group/".length)] : undefined;
    return new Response(url.origin !== ORIGIN ? "Not found" : (group?.page ?? PAGE), {
      headers: { "Content-Type": "text/html" },
    });
  });
  const engine = new BrowserCdpEngine(window.webContents);
  const checks: string[] = [];
  const report: FixtureReport = {
    passed: false,
    baseline: BASELINE,
    electron: process.versions.electron,
    checks,
    elapsedMs: 0,
    error: "",
  };
  const started = performance.now();
  const load = () => window.loadURL(`${ORIGIN}/fields`);
  const prepare = (selector: string) =>
    Effect.runPromise(engine.prepareSecret([{ kind: "css", selector }], "on_input"));
  /** Upstream's per-field rule, for every field of the request. */
  const codeFields = (prepared: { kinds: Array<{ oneTimeCode: boolean }> }) =>
    prepared.kinds.length > 0 && prepared.kinds.every((kind) => kind.oneTimeCode);
  const runPage = (expression: string) => window.webContents.executeJavaScript(expression);
  try {
    await load();
    for (const selector of [
      "#verificationCode",
      "#aria",
      "#wrapped",
      "#placeholder",
      "#ius-mfa-token",
      "#marked",
      "#otp-text",
    ]) {
      assert.equal(codeFields(await prepare(selector)), true, `The code field was not recognized: ${selector}`);
      checks.push(`${selector}: an authentication code field is recognized`);
    }
    // "labelled" and "unlabelled" have the word "label" in their id, which upstream's rule refuses.
    for (const selector of [
      "#cardVerificationCode",
      "#cvc",
      "#postalVerificationCode",
      "#ordinary",
      "#labelled",
      "#unlabelled",
    ]) {
      assert.equal(codeFields(await prepare(selector)), false, `An unrelated field was accepted: ${selector}`);
      checks.push(`${selector}: unrelated or mismatched fields are refused`);
    }
    for (const selector of ["#disabled-otp", "#readonly-otp", "#hidden-otp", "#invisible"]) {
      await assert.rejects(prepare(selector), `An unavailable field was accepted: ${selector}`);
      checks.push(`${selector}: unavailable fields are refused`);
    }
    // The host compares this origin with the page's site before a fill.
    assert.equal((await prepare("#verificationCode")).origin, ORIGIN, "The field's document origin is wrong.");
    checks.push("Preparation names the origin of the field's document");

    const ready = await prepare("#verificationCode");
    await Effect.runPromise(ready.enter([CODE]));
    assert.equal(
      await runPage(
        `document.querySelector('#verificationCode').value === ${JSON.stringify(CODE)} && window.trustedInputs === 1`,
      ),
      true,
      "Secure entry did not dispatch trusted input to the code field.",
    );
    assert.equal(await Effect.runPromise(ready.clear([CODE])), true, "Secure entry did not clear its fixture value.");
    checks.push("Recognized fields receive trusted input and clear the value");

    // Upstream's fingerprint keeps the id, name, autocomplete and aria-label of the field until entry.
    for (const [selector, mutation] of [
      ["#verificationCode", "document.querySelector('#verificationCode').name = 'search'"],
      [
        "#verificationCode",
        "document.querySelector('#verificationCode').setAttribute('autocomplete', 'one-time-code')",
      ],
      ["#placeholder", "document.querySelector('#placeholder').setAttribute('aria-label', 'Search')"],
      ["#verificationCode", "document.querySelector('#verificationCode').style.display = 'none'"],
    ]) {
      assert.ok(selector && mutation);
      await load();
      const prepared = await prepare(selector);
      await runPage(mutation);
      await assert.rejects(
        Effect.runPromise(prepared.enter([CODE])),
        "Changed authentication metadata permitted entry.",
      );
      assert.equal(
        await runPage("[...document.querySelectorAll('input')].every(input => input.value === '')"),
        true,
        "A rejected entry changed a field.",
      );
      checks.push(`${selector}: changed field metadata blocks entry`);
    }
    await load();
    const stale = await prepare("#verificationCode");
    await load();
    await assert.rejects(Effect.runPromise(stale.enter([CODE])), "A replacement document permitted stale entry.");
    checks.push("A replacement document blocks stale entry");

    const loadGroup = (name: string) => window.loadURL(`${ORIGIN}/group/${name}`);
    const idBox = (index: number) => `#box-${index}`;
    const prepareGroup = (count: number, splitCode = true, box = idBox) =>
      Effect.runPromise(
        engine.prepareSecret(
          Array.from({ length: count }, (_, index) => ({ kind: "css", selector: box(index) })),
          "on_input",
          undefined,
          splitCode,
        ),
      );
    /** The value of each box, in target order. */
    const boxValues = async (box = idBox): Promise<string[]> =>
      runPage(
        `${JSON.stringify(Array.from({ length: 6 }, (_, index) => box(index)))}.map(selector => document.querySelector(selector).value)`,
      );
    for (const [name, { targets, accepted, box }] of Object.entries(GROUPS)) {
      await loadGroup(name);
      assert.equal(
        (await prepareGroup(targets, true, box)).codeGroup,
        accepted,
        `The code group was classified wrongly: ${name}`,
      );
      checks.push(`group ${name}: ${accepted ? "accepted" : "refused"}`);
    }
    await loadGroup("bank");
    assert.equal((await prepareGroup(6, false)).codeGroup, false, "The group rule ran with no host request.");
    checks.push("group bank: no group check without the host's flag");

    // One digit goes to each box, also to a box that takes the whole code. The host spreads the code over
    // the boxes, as `BrowserHost.prepareSecret` does.
    for (const name of ["bank", "real-bank", "one-time-code"]) {
      const box = GROUPS[name]?.box;
      await loadGroup(name);
      const group = await prepareGroup(6, true, box);
      assert.equal(group.codeGroup || codeFields(group), true, `The code group did not take a vault code: ${name}`);
      await Effect.runPromise(group.enter([...CODE]));
      assert.deepEqual(await boxValues(box), [...CODE], `The code did not go one digit to each box: ${name}`);
      assert.equal(
        await runPage("window.trustedInputs"),
        6,
        `Entry did not send one trusted input to each box: ${name}`,
      );
      assert.equal(await Effect.runPromise(group.clear([CODE])), true, `Entry did not clear the boxes: ${name}`);
      checks.push(
        `group ${name}: ${name === "one-time-code" ? "the per-field rule, with no group check," : "the group rule"} fills one digit in each box`,
      );
    }

    // The group is checked again before the first digit goes in.
    for (const [name, mutation] of [
      ["bank", "document.querySelector('#box-2').setAttribute('aria-label', 'Search')"],
      ["labels", "document.querySelector('label[for=box-1]').textContent = 'Promo 2'"],
      ["bank", "document.querySelector('#box-4').maxLength = 2"],
      [
        "bank",
        "document.querySelector('#container').append(Object.assign(document.createElement('input'), { id: 'added' }))",
      ],
      ["bank", "document.querySelector('#container p').textContent = 'Enter the code from the SMS that we sent'"],
      ["bank", "const row = document.querySelector('#row'); row.append(row.firstElementChild)"],
    ] as const) {
      await loadGroup(name);
      const group = await prepareGroup(6);
      assert.equal(group.codeGroup, true, `The code group was not accepted before a change: ${name}`);
      await runPage(mutation);
      await assert.rejects(
        Effect.runPromise(group.enter([...CODE])),
        `A changed code group permitted entry: ${mutation}`,
      );
      assert.equal((await boxValues()).join(""), "", `A refused code group entry changed a box: ${mutation}`);
      checks.push(`group ${name}: a change blocks entry: ${mutation}`);
    }
    report.passed = true;
  } catch (cause) {
    report.error = cause instanceof Error ? cause.message : "The authentication checks failed.";
  } finally {
    report.elapsedMs = performance.now() - started;
    await writeFile(join(fixture, "worker-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await Effect.runPromise(engine.destroy());
    window.destroy();
    app.exit(report.passed ? 0 : 1);
  }
}
