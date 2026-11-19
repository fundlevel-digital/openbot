import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserJsonValue } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { BrowserWindow, webContents } from "electron";
import { type RawData, WebSocket } from "ws";
import { z } from "zod";
import type { BrowserHost } from "../src/backend/browser-host";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { DynamicToolCallParams } from "../src/backend/protocol";
import { bitwardenLoginFixture, runBitwardenBrowserSmoke } from "./bitwarden-browser-smoke";
import { waitForPresentedFrame } from "./browser-smoke-frames";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

/** The first frame host is on the page's site, the second is on another site. */
const FRAME_HOSTS = ["login.openbot.test", "login.other-site.test"];
const FRAME_PASSWORD = "fixture-frame-password-201938";

/**
 * A secure fill reaches a sign-in form in a frame of the page's site, with the vault origin of the
 * frame. A form in a frame of another site is refused (#10018, #10148).
 */
async function runFrameScenario(browser: BrowserHost): Promise<void> {
  const report: {
    vaultOrigin?: string;
    vaultFillable?: boolean;
    submission?: string;
    completed?: boolean;
    snapshotHasValue?: boolean;
    otherSiteRefused?: boolean;
  } = {};
  for (const path of ["framed", "framed-other"] as const) {
    const tab = await runCauseEffect(
      browser.open(`https://authentication.openbot.test/${path}`, "secret-thread", "secret-agent"),
    );
    try {
      const contents = webContents.getAllWebContents().find((item) => item.getURL() === tab.url);
      if (!contents) throw new Error(`Missing ${path} fixture.`);
      await waitForPresentedFrame(contents);
      // The frame loads after the page. Wait until the snapshot shows its fields.
      const deadline = Date.now() + 10_000;
      let read = await runCauseEffect(browser.snapshot(tab.id));
      const element = (name: string) => read.elements.find((item) => item.name === name);
      while ((!element("Frame password") || !element("Frame sign in")) && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            contents.off("did-frame-finish-load", done);
            resolve();
          };
          const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
          contents.once("did-frame-finish-load", done);
        });
        read = await runCauseEffect(browser.snapshot(tab.id));
      }
      const password = element("Frame password");
      const submit = element("Frame sign in");
      if (!password || !submit) throw new Error(`The ${path} snapshot does not show the frame's fields.`);
      const prepared = await runCauseEffect(
        browser.prepareSecret({
          namespace: "openbot_browser",
          tool: "submit_secret",
          threadId: "secret-thread",
          ownerAgentId: "secret-agent",
          turnId: "secret-turn",
          callId: `frame-${path}`,
          arguments: {
            tabId: tab.id,
            method: "password",
            targets: [{ kind: "ref", ref: password.ref, revision: read.revision }],
            submission: "click",
            submitTarget: { kind: "ref", ref: submit.ref, revision: read.revision },
          },
        }),
      ).then(
        (handoff) => ({ handoff, error: null }),
        (error: unknown) => ({ handoff: null, error: error instanceof Error ? error.message : String(error) }),
      );
      if (path === "framed-other") {
        report.otherSiteRefused = prepared.error?.includes("frame of another site") === true;
        continue;
      }
      if (!prepared.handoff) throw new Error(`Secure fill refused the same-site frame: ${prepared.error}`);
      report.vaultOrigin = prepared.handoff.request.origin;
      report.vaultFillable = prepared.handoff.vaultFillable;
      report.submission = await runCauseEffect(prepared.handoff.submit(FRAME_PASSWORD, true));
      const after = await runCauseEffect(browser.snapshot(tab.id));
      report.completed = after.url.endsWith("/complete");
      report.snapshotHasValue = JSON.stringify(after).includes(FRAME_PASSWORD);
    } finally {
      await runCauseEffect(browser.close(tab.id));
    }
  }
  const passed =
    report.vaultOrigin === `https://${FRAME_HOSTS[0]}` &&
    report.vaultFillable === true &&
    report.submission === "submitted" &&
    report.completed === true &&
    report.snapshotHasValue === false &&
    report.otherSiteRefused === true;
  await mkdir(".openbot-build", { recursive: true });
  await writeFile(
    ".openbot-build/browser-secret-frame.json",
    JSON.stringify({ status: passed ? "passed" : "issues_found", ...report }, null, 2),
  );
  if (!passed) throw new Error(`Secure fill in a frame is wrong: ${JSON.stringify(report)}`);
}

/** HTTPS is served inside this isolated session. No credentials or network service are used. */
export async function runSecretHandoffScenario(browser: BrowserHost, localOrigin: string): Promise<void> {
  const checks: string[] = [];
  const cliCommands: Array<{ version: string; methods: string[]; helperHashes: string[] }> = [];
  const seed = await runCauseEffect(browser.open(localOrigin, "secret-thread", "secret-agent"));
  const seedContents = webContents.getAllWebContents().find((contents) => contents.getURL() === seed.url);
  if (!seedContents) throw new Error("Missing authentication fixture session.");
  const protocol = seedContents.session.protocol;
  let mirroredPageLoads = 0;
  let modalPageLoads = 0;
  let stuckPageLoads = 0;
  let lostPageLoads = 0;
  let lostPageOffline = false;
  await protocol.handle("https", (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/frame-form" && FRAME_HOSTS.includes(url.hostname))
      // A sign-in form in a frame, as Apple's (#10018). The page goes on only when the frame got the value.
      return new Response(
        `<!doctype html><body>
        <label>Frame password<input id="frame-password" type="password"></label>
        <button id="frame-submit" onclick="parent.postMessage(document.querySelector('#frame-password').value === '${FRAME_PASSWORD}', 'https://authentication.openbot.test')">Frame sign in</button>
        </body>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (
      ![
        "authentication.openbot.test",
        "native-authentication.openbot.test",
        "inspected-authentication.openbot.test",
        "scripted-authentication.openbot.test",
        "called-authentication.openbot.test",
        "mutated-authentication.openbot.test",
        "modified-authentication.openbot.test",
        "cli027-authentication.openbot.test",
        "cli041-authentication.openbot.test",
      ].includes(url.hostname)
    )
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/framed" || url.pathname === "/framed-other")
      return new Response(
        `<!doctype html><body>
        <iframe title="Sign in" width="400" height="200" src="https://${url.pathname === "/framed" ? FRAME_HOSTS[0] : FRAME_HOSTS[1]}/frame-form"></iframe>
        <script>addEventListener('message', (event) => { if (event.origin.startsWith('https://login.')) location.href = event.data === true ? '/complete' : '/wrong'; });</script>
        </body>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (url.pathname === "/stuck") stuckPageLoads += 1;
    if (url.pathname === "/lost") {
      lostPageLoads += 1;
      // The page cannot load again, as when the computer is offline when the card ends (#9883).
      if (lostPageOffline) return Response.error();
      // The page copies the value into its title, so the fork's field cleanup cannot end the protection.
      // Its Sign in button never becomes enabled, so a fill that clicks it fails after the value went in.
      return new Response(
        `<!doctype html><body><label>Password<input id="password" type="password" oninput="document.title = this.value"></label>
        <button id="lost-submit" disabled>Sign in</button></body>`,
        { headers: { "Content-Type": "text/html" } },
      );
    }
    if (url.pathname === "/modal") {
      modalPageLoads += 1;
      // A password step in a dialog that holds more fields (#9643). The page copies the password into
      // an attribute, its text and its title, so the value stays in the page after OpenBot empties the field.
      return new Response(
        `<!doctype html><body>
        <dialog id="verify"><form method="dialog">
        <label>Password<input id="password" type="password" oninput="const copy = document.querySelector('#strength'); copy.dataset.value = this.value; copy.textContent = this.value; document.title = this.value"></label>
        <label>Code<input id="code" inputmode="numeric"></label>
        <span id="strength"></span>
        <button id="validate" type="button">Validate</button></form></dialog></body>`,
        { headers: { "Content-Type": "text/html" } },
      );
    }
    if (url.pathname === "/cli-login")
      return new Response(
        `<!doctype html><title>CLI authentication fixture</title>
        <label>Email<input id="email" type="email"></label>
        <button id="password-choice" onclick="document.querySelector('#login').hidden = false">Use password</button>
        <form id="login" hidden method="post" action="/cli-code" onsubmit="if(document.querySelector('#cli-password').value!=='fixture-cli-password')event.preventDefault()">
        <label>Password<input id="cli-password" type="password" autocomplete="current-password"></label>
        <button id="cli-submit">Sign in</button></form>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (url.pathname === "/cli-code")
      return new Response(
        `<!doctype html><title>Authenticator fixture</title>
        <form method="post" action="/complete" onsubmit="if(document.querySelector('#cli-code').value!=='739182')event.preventDefault()"><label>Authenticator code<input id="cli-code" inputmode="numeric" autocomplete="one-time-code"></label>
        <button id="cli-verify">Verify</button></form>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (url.pathname === "/bitwarden-password") return bitwardenLoginFixture("password");
    if (url.pathname === "/bitwarden-authenticator") {
      const field = url.searchParams.get("field");
      return bitwardenLoginFixture("authenticator", field === "totp" || field === "numeric" ? field : "marked");
    }
    if (url.pathname === "/authenticator-fields")
      return new Response(
        `<!doctype html><body>
        <input id="totpPin" type="tel" autocomplete="off">
        <input id="otp-text" type="text">
        <input id="phone" type="tel">
        <input id="numeric" inputmode="numeric">
        <input id="card" inputmode="numeric" aria-label="Authenticator code" autocomplete="cc-csc">
        <input id="otp-password" type="password" inputmode="numeric">
        <input id="notp" inputmode="numeric">
        ${Array.from({ length: 6 }, (_, index) => `<input id="otp-${index}" inputmode="numeric" maxlength="1">`).join("")}
        </body>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (url.pathname === "/split-password")
      // The password step before the split code. It opens the code step that `next` names.
      return new Response(
        `<!doctype html><body><label>Password<input id="split-password" type="password"></label>
        <button id="split-sign-in" type="button" onclick="location.href = new URLSearchParams(location.search).get('next')">Sign in</button></body>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (url.pathname === "/split-code" || url.pathname === "/split-code-get") {
      // A bank's authenticator step: six boxes named "1 digit" to "6 digit" and the app named two levels
      // above their row. The fork's group rule takes a vault code here. The GET form sends it in parts.
      const get = url.pathname === "/split-code-get";
      const tag = get ? "form" : "div";
      const boxes = Array.from(
        { length: 6 },
        (_, index) =>
          `<div><input id="split-${index}" name="d${index + 1}" aria-label="${index + 1} digit" style="width:40px;height:48px"></div>`,
      ).join("");
      return new Response(
        `<!doctype html><body><${tag} id="sign-in" ${get ? 'method="get" action="/search"' : ""}>
        <h2>Two-step verification</h2><p>To verify it's you, enter a code from your authenticator app</p>
        <p>Check your Authenticator app</p><div><div style="display:flex;gap:8px">${boxes}</div></div>
        <button id="split-back" type="button">Back</button>
        <button id="split-continue" ${get ? "" : `type="button" onclick="if ([...document.querySelectorAll('#sign-in input')].map((input) => input.value).join('') === '518302') location.href = '/complete'; else document.querySelector('#answer').textContent = 'Wrong code'"`}>Continue</button>
        </${tag}><p id="answer"></p></body>`,
        { headers: { "Content-Type": "text/html" } },
      );
    }
    if (url.pathname === "/signup")
      // A sign-up form: it sends only when the password and its confirmation match (#6333).
      return new Response(
        `<!doctype html><body>
        <label>Name<input id="name" type="text"></label>
        <label>Password<input id="password" type="password"></label>
        <label>Confirm password<input id="confirm" type="password"></label>
        <button id="submit" onclick="const password = document.querySelector('#password').value; if (password && password === document.querySelector('#confirm').value) location.href = '/complete'">Register</button>
        </body>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (url.pathname === "/mirrored") {
      mirroredPageLoads += 1;
      // A single-page sign-in as React renders it: the field's value is copied to its value attribute,
      // and the answer shows in the same document.
      return new Response(
        `<!doctype html><body>
        <label>Password<input id="password" type="password" oninput="this.setAttribute('value', this.value)"></label>
        <button id="submit" onclick="document.querySelector('#answer').textContent = 'Wrong password'">Sign in</button>
        <p id="answer"></p></body>`,
        { headers: { "Content-Type": "text/html" } },
      );
    }
    const html =
      url.pathname === "/complete"
        ? "<h1>Signed in</h1>"
        : `
      <label>Password<input id="password" type="password"></label>
      <label>Code<input id="code" inputmode="numeric"></label>
      ${
        url.pathname === "/combined"
          ? `<label>Authenticator code<input id="combined-code" autocomplete="one-time-code" inputmode="numeric"></label>
      <button id="combined-submit" onclick="if (document.querySelector('#password').value && /^[0-9]{6}$/.test(document.querySelector('#combined-code').value)) location.href = '/complete'">Sign in with code</button>`
          : ""
      }
      ${
        url.pathname === "/login"
          ? `<form method="get" action="/search"><label>Search password<input id="get-password" name="password" type="password"></label></form>
      <form action="/search"><label>Default password<input id="default-password" name="password" type="password"></label></form>
      <form method="post" action="/search"><label>Override password<input id="override-password" name="password" type="password"></label><button id="override-submit" formmethod="get">Go</button></form>
      <label>One-time code<input id="otp" name="otp" type="text" autocomplete="off"></label>
      <label>MFA code<input id="totpmfa" name="totpmfa" type="text"></label>
      <label>Recovery code<input id="recovery-otp" name="recoveryOtp" type="text"></label>
      <label>SMS code<input id="sms-otp" name="smsOtp" type="text"></label>
      <label>Phone<input id="two-factor-phone" name="twoFactorPhone" type="tel"></label>
      <form><h2>Verify with Google Authenticator</h2><p>Enter the temporary code generated in your Google Authenticator app.</p><label for="okta-code">Enter code</label><input id="okta-code" name="credentials.passcode" type="text" autocomplete="off"><a href="#">Verify with something else</a></form>
      <form><h2>Verify with your email</h2><p>We sent an email to you.</p><label for="okta-second-code">Enter code</label><input id="okta-second-code" name="credentials.passcode" type="text" autocomplete="off"></form>
      <form><p>We emailed you a code.</p><label>Enter code<input id="fallback-code" type="text"></label><a href="#">Use an authenticator app instead</a></form>
      <form><label>Authentication code<input id="squarespace-code" name="code" type="text"></label></form>
      <form><input id="userid" type="number" placeholder="••••••"><label for="userid">External TOTP</label></form>
      <form><p>Open your Google Authenticator app.</p><label>Enter code<input id="answer" name="answer" type="text"></label><label>Promo code<input id="promo-code" type="text"></label></form>
      <form><script>const totpEnabled = true;</script><p hidden>Authenticator</p><label>Enter code<input id="plain-form-code" type="text"></label></form>
      <form method="post" action="/session"><label>Post password<input id="post-password" type="password"></label></form>
      <form method="post" action="/session"><label>Masked password<input id="masked-password" type="text" style="-webkit-text-security: disc"></label></form>
      <form action="/search" onsubmit="event.preventDefault(); location.href = '/complete'"><label>Script password<input id="script-password" name="password" type="password"></label></form>
      <form action="/search" onsubmit="event.preventDefault(); setTimeout(() => this.submit())"><label>Checked password<input id="checked-password" name="password" type="password"></label></form>`
          : ""
      }
      <div>${Array.from({ length: 6 }, (_, index) => `<input aria-label="Digit ${index + 1}" id="digit-${index}" maxlength="1">`).join("")}</div>
      <button id="submit" disabled onclick="${url.pathname === "/native-submit" ? "if (!event.isTrusted) return; " : ""}${url.pathname === "/same-page" ? "history.replaceState({}, '', '/complete')" : "location.href='/complete'"}">Sign in</button>
      <script>
      ${url.pathname === "/component" ? `const host = document.createElement('div'); document.body.append(host); const root = host.attachShadow({mode: 'open'}); root.append(...document.querySelectorAll('input'));` : ""}
      document.addEventListener('input', event => { if (${url.pathname === "/component"} && !event.isTrusted) return; ${url.pathname === "/native-submit" ? "setTimeout(() => { document.querySelector('#submit').disabled = false; }, 100);" : "document.querySelector('#submit').disabled = false;"}
      ${["/failed-submit", "/failed-submit-clean"].includes(url.pathname) ? "const button = document.querySelector('#submit'); button.replaceWith(button.cloneNode(true));" : ""}
      ${url.pathname === "/failed-submit-clean" ? "" : "console.error(event.target.value); document.title = event.target.value;"} });</script>`;
    return new Response(`<!doctype html><body>${html}</body>`, { headers: { "Content-Type": "text/html" } });
  });
  await runCauseEffect(browser.close(seed.id));
  try {
    // The real host and Chromium navigation use an injected OS boundary. No OS input is needed.
    // Like the real control, it lends the page view to a window: a view with no window has no frame.
    const nativeWindows = new Map<string, BrowserWindow>();
    browser.setNativeControl({
      ready: () => true,
      open: (tabId, view) =>
        Effect.sync(() => {
          const window = new BrowserWindow({ width: 800, height: 600, frame: false });
          window.contentView.addChildView(view);
          const { width, height } = window.getContentBounds();
          view.setBounds({ x: 0, y: 0, width, height });
          view.setVisible(true);
          nativeWindows.set(tabId, window);
        }),
      close: (tabId) =>
        Effect.sync(() => {
          const window = nativeWindows.get(tabId);
          nativeWindows.delete(tabId);
          if (!window || window.isDestroyed()) return;
          for (const child of [...window.contentView.children]) window.contentView.removeChildView(child);
          window.destroy();
        }),
      snapshot: () => Effect.die(new Error("This fixture must not capture the OS.")),
      input: () => Effect.die(new Error("This fixture must not send OS input.")),
    });
    for (const mode of ["native", "inspected", "scripted", "called", "mutated", "modified"] as const) {
      const native = mode === "native";
      const host = `${mode}-authentication.openbot.test`;
      const tab = await runCauseEffect(browser.open(localOrigin, "secret-thread", "secret-agent"));
      try {
        const connection = await runCauseEffect(
          browser.handleDynamicTool(
            {
              namespace: "openbot_browser",
              tool: native ? "set_control_mode" : "connect_cdp",
              threadId: "secret-thread",
              ownerAgentId: "secret-agent",
              turnId: "secret-turn",
              callId: `origin-${mode}`,
              arguments: { tabId: tab.id, ...(native ? { mode: "native" } : {}) },
            },
            { nativeControlAllowed: () => true },
          ),
        );
        if (!connection.success) throw new Error("The origin fixture could not connect.");
        const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === tab.url);
        if (!contents) throw new Error("Missing origin fixture page.");
        await contents.loadURL(`https://${host}/login`);
        await waitForPresentedFrame(contents);
        let closed: Promise<unknown[]> | undefined;
        if (!native) {
          const item = connection.contentItems.find((entry) => entry.type === "inputText");
          if (item?.type !== "inputText") throw new Error("Missing inspection endpoint.");
          const endpoint = z.object({ endpoint: z.string() }).parse(JSON.parse(item.text)).endpoint;
          const socket = new WebSocket(endpoint);
          await once(socket, "open");
          closed = once(socket, "close");
          let sequence = 0;
          const responseSchema = z.object({
            id: z.number().optional(),
            result: z.json().optional(),
            error: z.json().optional(),
          });
          const send = async (method: string, params: Record<string, BrowserJsonValue> = {}) => {
            const id = ++sequence;
            const answer = new Promise<z.infer<typeof responseSchema>>((resolve) => {
              const receive = (data: RawData) => {
                const response = responseSchema.parse(JSON.parse(data.toString()));
                if (response.id !== id) return;
                socket.off("message", receive);
                resolve(response);
              };
              socket.on("message", receive);
            });
            socket.send(JSON.stringify({ id, method, params }));
            const response = await answer;
            if (response.error) throw new Error(`Inspection fixture command failed: ${method}`);
            return response.result;
          };
          for (const method of [
            "Page.enable",
            "Runtime.enable",
            "Network.enable",
            "DOM.enable",
            "Accessibility.enable",
          ])
            await send(method);
          const tree = await send("Accessibility.getFullAXTree");
          if (!JSON.stringify(tree).includes("Password")) throw new Error("CDP did not read the real login page.");
          if (mode === "scripted")
            await send("Runtime.evaluate", {
              expression: "document.querySelector('#password').addEventListener('input', () => {}); true",
            });
          if (mode === "modified")
            await send("Runtime.evaluate", {
              expression:
                "(function(){ var els = document.querySelectorAll('[data-__ab-ci]'); for (var i = 0; i < els.length; i++) els[i].removeAttribute('data-__ab-ci'); return els.length; })(); document.querySelector('#password').addEventListener('input', () => {});",
            });
          if (mode === "mutated" || mode === "called") {
            const document = z.object({ root: z.object({ nodeId: z.number() }) }).parse(await send("DOM.getDocument"));
            const field = z
              .object({ nodeId: z.number() })
              .parse(await send("DOM.querySelector", { nodeId: document.root.nodeId, selector: "#password" }));
            if (mode === "mutated")
              await send("DOM.setAttributeValue", { nodeId: field.nodeId, name: "oninput", value: "void 0" });
            else {
              const node = z
                .object({ object: z.object({ objectId: z.string() }) })
                .parse(await send("DOM.resolveNode", { nodeId: field.nodeId }));
              await send("Runtime.callFunctionOn", {
                objectId: node.object.objectId,
                functionDeclaration: "function() { this.addEventListener('input', () => {}); }",
              });
            }
          }
        }
        const prepared = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `origin-secret-${mode}`,
            arguments: {
              tabId: tab.id,
              method: "password",
              targets: [{ kind: "css", selector: "#password" }],
              submission: "click",
              submitTarget: { kind: "css", selector: "#submit" },
            },
          }),
        );
        if (closed) await closed;
        const scripted = mode === "scripted" || mode === "called" || mode === "mutated" || mode === "modified";
        if (prepared.agentScriptedOrigin !== scripted)
          throw new Error(`The host classified ${mode} access incorrectly for vault fill.`);
        if (mode === "inspected") {
          if (
            !prepared.vaultFillable ||
            (await runCauseEffect(prepared.submit("fixture-inspected-password", true))) !== "submitted"
          )
            throw new Error("Read-only CDP inspection prevented a saved-password submission.");
          if (!(await runCauseEffect(browser.snapshot(tab.id))).url.endsWith("/complete"))
            throw new Error("Read-only inspected login did not complete.");
        }
        prepared.cancel();
        checks.push(`${mode}: ${scripted ? "script access blocks" : "inspection retains"} automatic vault fill`);
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    for (const version of ["0.27.0", "0.41.2"]) {
      const host = version === "0.27.0" ? "cli027-authentication.openbot.test" : "cli041-authentication.openbot.test";
      const tab = await runCauseEffect(browser.open(`https://${host}/cli-login`, "secret-thread", "secret-agent"));
      const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === tab.url);
      if (!contents) throw new Error("Missing CLI authentication page.");
      const methods = new Set<string>();
      const helperHashes = new Set<string>();
      const originalSend = contents.debugger.sendCommand;
      const cliSession = `openbot-vault-${randomUUID()}`;
      const connection = await runCauseEffect(
        browser.handleDynamicTool({
          namespace: "openbot_browser",
          tool: "connect_cdp",
          threadId: "secret-thread",
          ownerAgentId: "secret-agent",
          turnId: "secret-turn",
          callId: `cli-${version}`,
          arguments: { tabId: tab.id },
        }),
      );
      const item = connection.contentItems.find((entry) => entry.type === "inputText");
      if (!connection.success || item?.type !== "inputText") throw new Error("Missing CLI authentication endpoint.");
      const endpoint = z.object({ endpoint: z.string() }).parse(JSON.parse(item.text)).endpoint;
      const cli = async (...args: string[]) => {
        const child = spawn("bunx", [`agent-browser@${version}`, "--session", cliSession, "--cdp", endpoint, ...args], {
          env: withoutElectronRuntimeFlags(process.env),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (data) => {
          output += data.toString();
        });
        child.stderr.on("data", (data) => {
          output += data.toString();
        });
        const [code] = await once(child, "close");
        if (code !== 0) throw new Error(`Fixture agent-browser ${version} ${args[0]} failed: ${output}`);
        return output;
      };
      let cliOpen = true;
      try {
        await waitForPresentedFrame(contents);
        contents.debugger.sendCommand = (method, params, sessionId) => {
          methods.add(method);
          const source =
            method === "Runtime.evaluate"
              ? params?.expression
              : method === "Runtime.callFunctionOn"
                ? params?.functionDeclaration
                : undefined;
          if (typeof source === "string") helperHashes.add(createHash("sha256").update(source).digest("hex"));
          return originalSend.call(contents.debugger, method, params, sessionId);
        };
        const snapshot = await cli("snapshot", "-i");
        const email = /textbox "Email" \[ref=(e\d+)\]/u.exec(snapshot)?.[1];
        const password = /button "Use password" \[ref=(e\d+)\]/u.exec(snapshot)?.[1];
        if (!email || !password) throw new Error(`agent-browser ${version} did not find the login methods.`);
        if (version === "0.27.0") {
          await cli("fill", `@${email}`, "fixture@example.test");
          await cli("click", `@${password}`);
          if ((await contents.executeJavaScript("document.querySelector('#email').value")) !== "fixture@example.test")
            throw new Error("The real CLI did not fill the fixture username.");
        } else await contents.executeJavaScript("document.querySelector('#login').hidden = false");
        await cli("close");
        cliOpen = false;
        contents.debugger.sendCommand = originalSend;
        for (const [method, selector, submitTarget, value, path] of [
          ["password", "#cli-password", "#cli-submit", "fixture-cli-password", "/cli-code"],
          ["authenticator", "#cli-code", "#cli-verify", "739182", "/complete"],
        ] as const) {
          await waitForPresentedFrame(contents);
          const handoff = await runCauseEffect(
            browser.prepareSecret({
              namespace: "openbot_browser",
              tool: "submit_secret",
              threadId: "secret-thread",
              ownerAgentId: "secret-agent",
              turnId: "secret-turn",
              callId: `cli-secret-${version}-${method}`,
              arguments: {
                tabId: tab.id,
                method,
                digits: 6,
                targets: [{ kind: "css", selector }],
                submission: "click",
                submitTarget: { kind: "css", selector: submitTarget },
              },
            }),
          );
          if (handoff.agentScriptedOrigin || !handoff.vaultFillable)
            throw new Error(`agent-browser ${version} disabled the ${method} vault fill.`);
          if ((await runCauseEffect(handoff.submit(value, true))) !== "submitted")
            throw new Error(`agent-browser ${version} ${method} submission failed.`);
          const result = await runCauseEffect(browser.snapshot(tab.id));
          if (new URL(result.url).pathname !== path || JSON.stringify(result).includes(value))
            throw new Error("CLI authentication failed or exposed its value.");
        }
        checks.push(`agent-browser ${version}: real snapshot before saved password and authenticator fill`);
      } finally {
        contents.debugger.sendCommand = originalSend;
        if (cliOpen) await cli("close").catch(() => {});
        cliCommands.push({ version, methods: [...methods].sort(), helperHashes: [...helperHashes].sort() });
        const directory = join(process.cwd(), ".openbot-build", "browser-secret");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "cli-commands.json"), JSON.stringify(cliCommands, null, 2));
        await runCauseEffect(browser.close(tab.id));
      }
    }
    await runBitwardenBrowserSmoke(browser);
    checks.push("saved passwords and authenticator codes submit without exposing values");
    // Upstream's rule (#8524): a text, tel or number field whose id, name, label or placeholder has a
    // code word takes a vault code; a card, phone or password field does not.
    for (const [selectors, fillable] of [
      [["#totpPin"], true],
      [["#otp-text"], true],
      [["#phone"], false],
      [["#numeric"], false],
      [["#card"], false],
      [["#otp-password"], false],
      [["#notp"], false],
      [Array.from({ length: 6 }, (_, index) => `#otp-${index}`), true],
      [["#otp-0", "#otp-1", "#otp-2", "#otp-3", "#otp-4", "#numeric"], false],
    ] as const) {
      const tab = await runCauseEffect(
        browser.open("https://authentication.openbot.test/authenticator-fields", "secret-thread", "secret-agent"),
      );
      try {
        const handoff = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `authenticator-${selectors.join()}`,
            arguments: {
              tabId: tab.id,
              method: "authenticator",
              digits: 6,
              targets: selectors.map((selector) => ({ kind: "css", selector })),
              submission: "on_input",
            },
          }),
        );
        handoff.cancel();
        if (handoff.vaultFillable !== fillable)
          throw new Error(`${selectors.join()} was classified wrongly for a vault authenticator code.`);
        checks.push(`${selectors.join()}: vault fill ${fillable ? "allowed" : "refused"}`);
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    for (const path of ["failed-submit", "failed-submit-clean"]) {
      const tab = await runCauseEffect(
        browser.open(`https://authentication.openbot.test/${path}`, "secret-thread", "secret-agent"),
      );
      try {
        const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === tab.url);
        if (!contents) throw new Error("Missing failed submission fixture.");
        await waitForPresentedFrame(contents);
        const handoff = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `failed-${path}`,
            arguments: {
              tabId: tab.id,
              method: "password",
              targets: [{ kind: "css", selector: "#password" }],
              submission: "click",
              submitTarget: { kind: "css", selector: "#submit" },
            },
          }),
        );
        const secret = "fixture-failed-password-729104";
        const failure = await runCauseEffect(handoff.submit(secret, true)).then(
          () => false,
          () => true,
        );
        if (!failure) throw new Error("A replaced submit target must not report success.");
        handoff.cancel();
        await runCauseEffect(browser.beginTakeover(tab.id));
        const snapshot = await runCauseEffect(browser.snapshot(tab.id));
        if (JSON.stringify(snapshot).includes(secret)) throw new Error("Failed submission exposed a value.");
        if ((await contents.executeJavaScript("document.querySelector('#password').value")) !== "")
          throw new Error("Failed submission left a password in its field.");
        const preview = await runCauseEffect(browser.capturePreview(tab.id));
        if (!preview.dataUrl.startsWith("data:image/")) throw new Error("The sanitized takeover has no preview.");
        const evaluate = () =>
          runCauseEffect(
            browser.handleDynamicTool({
              namespace: "openbot_browser",
              tool: "evaluate",
              threadId: "secret-thread",
              ownerAgentId: "secret-agent",
              turnId: "secret-turn",
              callId: `recover-${path}`,
              arguments: { tabId: tab.id, expression: "document.title" },
            }),
          );
        if (path === "failed-submit-clean" && (await evaluate()).success)
          throw new Error("A retained secret document must still block evaluation.");
        await runCauseEffect(browser.reload(tab.id));
        browser.endTakeover(tab.id);
        if (!(await evaluate()).success) throw new Error("Reload did not restore browser access.");
        checks.push(`${path}: failed entry cleans the page and retains manual recovery`);
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    for (const [method, path] of [
      ["password", "login"],
      ["otp", "login"],
      ["authenticator", "login"],
      ["password", "same-page"],
      ["password", "component"],
      ["password", "native-submit"],
    ] as const) {
      const tab = await runCauseEffect(
        browser.open(`https://authentication.openbot.test/${path}`, "secret-thread", "secret-agent"),
      );
      // The submission clicks Sign in; a tab with no frame yet would drop that click.
      const tabContents = webContents.getAllWebContents().find((contents) => contents.getURL() === tab.url);
      if (!tabContents) throw new Error(`Missing ${path} fixture.`);
      await waitForPresentedFrame(tabContents);
      const params: DynamicToolCallParams = {
        namespace: "openbot_browser",
        tool: "submit_secret",
        threadId: "secret-thread",
        ownerAgentId: "secret-agent",
        turnId: "secret-turn",
        callId: `secret-${method}`,
        arguments: {
          tabId: tab.id,
          method,
          targets:
            method === "authenticator"
              ? Array.from({ length: 6 }, (_, index) => ({ kind: "css", selector: `#digit-${index}` }))
              : [{ kind: "css", selector: method === "password" ? "#password" : "#code" }],
          submission: "click",
          submitTarget: { kind: "css", selector: "#submit" },
        },
      };
      try {
        let externalClosed: Promise<unknown[]> | undefined;
        if (method === "password" && path === "login") {
          const connection = await runCauseEffect(
            browser.handleDynamicTool({ ...params, tool: "connect_cdp", arguments: { tabId: tab.id } }),
          );
          const item = connection.contentItems.find((entry) => entry.type === "inputText");
          if (!connection.success || item?.type !== "inputText") throw new Error("Missing secret-revocation endpoint.");
          const endpoint = z.object({ endpoint: z.string() }).parse(JSON.parse(item.text)).endpoint;
          const socket = new WebSocket(endpoint);
          await once(socket, "open");
          externalClosed = once(socket, "close");
        }
        const handoff = await runCauseEffect(browser.prepareSecret(params));
        if (externalClosed) {
          await externalClosed;
          checks.push("secure input revokes an existing external CDP connection");
        }
        // Only a real password field may take a vault password with no card; the digit boxes do not
        // ask for a one-time code, and an email or SMS code never comes from the vault. The fork's split
        // code group rule refuses them too: their row names no authenticator app, and the body has
        // other text inputs.
        if (handoff.vaultFillable !== (method === "password"))
          throw new Error(`The ${method} fields were classified wrongly for a vault fill.`);
        for (const tool of ["snapshot", "screenshot"]) {
          const capture = await runCauseEffect(
            browser.handleDynamicTool({ ...params, tool, arguments: { tabId: tab.id } }),
          );
          if (capture.success) throw new Error("Agent capture was not blocked while awaiting consent.");
        }
        const result = await runCauseEffect(
          browser.handleDynamicTool({
            ...params,
            tool: "evaluate",
            arguments: { tabId: tab.id, expression: "document.body.innerText" },
          }),
        );
        if (result.success) throw new Error("Authentication evaluation was not blocked.");
        const secret = method === "password" ? "fixture-password-729104" : "729104";
        if ((await runCauseEffect(handoff.submit(secret, false))) !== "submitted")
          throw new Error(`Secure ${method} submission did not navigate.`);
        const snapshot = await runCauseEffect(browser.snapshot(tab.id));
        if (JSON.stringify(snapshot).includes(secret)) throw new Error("Authentication value reached a snapshot.");
        if (!snapshot.url.endsWith("/complete")) throw new Error("Authentication fixture did not complete.");
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    // A sign-in page that sets its address while the card is open keeps its fields, so the fill still
    // goes through (#10462). Many mail sign-in pages do this for the password step.
    {
      const tab = await runCauseEffect(
        browser.open("https://authentication.openbot.test/address-change", "secret-thread", "secret-agent"),
      );
      try {
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === tab.url);
        if (!contents) throw new Error("Missing address change fixture.");
        await waitForPresentedFrame(contents);
        const handoff = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: "secret-address-change",
            arguments: {
              tabId: tab.id,
              method: "password",
              targets: [{ kind: "css", selector: "#password" }],
              submission: "click",
              submitTarget: { kind: "css", selector: "#submit" },
            },
          }),
        );
        await contents.executeJavaScript(
          "history.replaceState({}, '', '/address-change?step=password'); history.pushState({}, '', '/address-change/password'); location.hash = 'password'",
        );
        const secret = "fixture-address-change-password-5531";
        if ((await runCauseEffect(handoff.submit(secret, false))) !== "submitted")
          throw new Error("A same-document address change stopped the secure password fill.");
        const snapshot = await runCauseEffect(browser.snapshot(tab.id));
        if (JSON.stringify(snapshot).includes(secret)) throw new Error("Authentication value reached a snapshot.");
        if (!snapshot.url.endsWith("/complete")) throw new Error("The address change fixture did not complete.");
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    // A form that sends the password and the authenticator code in one submit gets both from one saved
    // login. The page goes on only when both fields hold a value at the click, so a fill that empties
    // the first field before the second one fails here.
    const combinedPassword = "fixture-combined-password-418";
    const combinedCode = "604213";
    {
      const tab = await runCauseEffect(
        browser.open("https://authentication.openbot.test/combined", "secret-thread", "secret-agent"),
      );
      try {
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === tab.url);
        if (!contents) throw new Error("Missing combined sign-in fixture.");
        await waitForPresentedFrame(contents);
        const params = ({ saved = true, codeSelector = "#combined-code" } = {}): DynamicToolCallParams => ({
          namespace: "openbot_browser",
          tool: "submit_secret",
          threadId: "secret-thread",
          ownerAgentId: "secret-agent",
          turnId: "secret-turn",
          callId: "secret-combined",
          arguments: {
            tabId: tab.id,
            method: "password",
            ...(saved ? { loginId: "combined-login" } : {}),
            targets: [
              { kind: "css", selector: "#password" },
              { kind: "css", selector: codeSelector },
            ],
            digits: 6,
            submission: "click",
            submitTarget: { kind: "css", selector: "#combined-submit" },
          },
        });
        // A password target with code fields needs a saved login, and a field that does not ask for a
        // code is not a code field.
        const refused = await runCauseEffect(browser.prepareSecret(params({ saved: false }))).then(
          () => false,
          () => true,
        );
        if (!refused) throw new Error("Password and code targets were accepted without a saved login.");
        const wrongField = await runCauseEffect(browser.prepareSecret(params({ codeSelector: "#code" })));
        wrongField.cancel();
        if (wrongField.vaultFillable || !wrongField.withCode)
          throw new Error("A field that does not ask for a code was classified as a code field.");
        const handoff = await runCauseEffect(browser.prepareSecret(params()));
        if (!handoff.vaultFillable || !handoff.withCode)
          throw new Error("The password and code fields were classified wrongly for a vault fill.");
        if ((await runCauseEffect(handoff.submit(combinedPassword, true, combinedCode))) !== "submitted")
          throw new Error("The combined sign-in did not go on: a field was empty at the submit.");
        const snapshot = await runCauseEffect(browser.snapshot(tab.id));
        if ([combinedPassword, combinedCode].some((value) => JSON.stringify(snapshot).includes(value)))
          throw new Error("A combined sign-in value reached a snapshot.");
        if (!snapshot.url.endsWith("/complete")) throw new Error("Combined sign-in fixture did not complete.");
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    // A field built for something else must not take a vault password: its value can reach a URL. A
    // text field that the page masks as a password, as some bank sign-in pages do, is a password field.
    // A password field may, in any form, but a navigation that carries a vault value is blocked and the
    // user finishes. A form that the page sends with its own script, as many sign-in forms with no
    // method do, still signs in.
    const vaultPassword = "fixture vault+password/518302";
    for (const [selector, fillable, path, outcome] of [
      ["#code", false, undefined, undefined],
      ["#get-password", true, "/login", "takeover"],
      ["#default-password", true, "/login", "takeover"],
      ["#override-password", true, "/login", "takeover"],
      ["#checked-password", true, "/login", "takeover"],
      ["#post-password", true, "/session", "submitted"],
      ["#masked-password", true, "/session", "submitted"],
      ["#script-password", true, "/complete", "submitted"],
    ] as const) {
      const tab = await runCauseEffect(
        browser.open("https://authentication.openbot.test/login", "secret-thread", "secret-agent"),
      );
      try {
        const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === tab.url);
        if (!contents) throw new Error("Missing vault form fixture.");
        await waitForPresentedFrame(contents);
        const handoff = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `vault-${selector}`,
            arguments: {
              tabId: tab.id,
              method: "password",
              targets: [{ kind: "css", selector }],
              submission: selector === "#override-password" ? "click" : "enter",
              ...(selector === "#override-password"
                ? { submitTarget: { kind: "css", selector: "#override-submit" } }
                : {}),
            },
          }),
        );
        if (handoff.vaultFillable !== fillable) {
          handoff.cancel();
          throw new Error(`${selector} was classified wrongly for a vault password.`);
        }
        if (!path) {
          handoff.cancel();
          continue;
        }
        const result = await runCauseEffect(handoff.submit(vaultPassword, true));
        const snapshot = await runCauseEffect(browser.snapshot(tab.id));
        if (new URL(snapshot.url).pathname !== path || result !== outcome)
          throw new Error(
            `A vault password in ${selector} reached ${snapshot.url} (${result}), not ${path} (${outcome}).`,
          );
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    // A vault code goes only to a code field. An older Keycloak page names it otp with no
    // autocomplete="one-time-code"; Okta names it passcode, and Squarespace and Kite name it only in its
    // label (#8320). A field named only "code" or "passcode" takes it in a form whose visible text names
    // an authenticator app and no email. A recovery, SMS, phone, or promo field, an email code field, or
    // a plain code field in another form does not take it, also when hidden text names an app.
    for (const [selector, fillable] of [
      ["#otp", true],
      ["#totpmfa", true],
      ["#okta-code", true],
      ["#okta-second-code", false],
      ["#fallback-code", false],
      ["#squarespace-code", true],
      ["#userid", true],
      ["#answer", true],
      ["#promo-code", false],
      ["#plain-form-code", false],
      ["#recovery-otp", false],
      ["#sms-otp", false],
      ["#two-factor-phone", false],
      ["#code", false],
    ] as const) {
      const tab = await runCauseEffect(
        browser.open("https://authentication.openbot.test/login", "secret-thread", "secret-agent"),
      );
      try {
        const handoff = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `vault-code-${selector}`,
            arguments: {
              tabId: tab.id,
              method: "authenticator",
              targets: [{ kind: "css", selector }],
              submission: "enter",
            },
          }),
        );
        handoff.cancel();
        if (handoff.vaultFillable !== fillable) throw new Error(`${selector} was classified wrongly for a vault code.`);
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    // The fork's split code group takes a vault code, one digit in each box, only as the step right after
    // a saved password fill of the same origin in the same tab, and only once. A GET form of the boxes
    // would send the code in parts in its URL, so that navigation is blocked and the user finishes.
    const splitDigits = Array.from({ length: 6 }, (_, index) => ({ kind: "css", selector: `#split-${index}` }));
    const prepareSplit = (tabId: string, args: Record<string, BrowserJsonValue>) =>
      runCauseEffect(
        browser.prepareSecret({
          namespace: "openbot_browser",
          tool: "submit_secret",
          threadId: "secret-thread",
          ownerAgentId: "secret-agent",
          turnId: "secret-turn",
          callId: `split-${randomUUID()}`,
          arguments: { tabId, ...args },
        }),
      );
    const splitGroup = { method: "authenticator", digits: 6, targets: splitDigits, submission: "on_input" };
    const unpaired = await runCauseEffect(
      browser.open("https://authentication.openbot.test/split-code", "secret-thread", "secret-agent"),
    );
    try {
      const handoff = await prepareSplit(unpaired.id, splitGroup);
      handoff.cancel();
      if (handoff.vaultFillable)
        throw new Error("A split code group with no saved password before it was vault-fillable.");
      checks.push("/split-code: a split code group with no saved password fill before it goes to the card");
    } finally {
      await runCauseEffect(browser.close(unpaired.id));
    }
    for (const [path, outcome, end] of [
      ["/split-code", "submitted", "/complete"],
      ["/split-code-get", "takeover", "/split-code-get"],
    ] as const) {
      const tab = await runCauseEffect(
        browser.open(
          `https://authentication.openbot.test/split-password?next=${path}`,
          "secret-thread",
          "secret-agent",
        ),
      );
      try {
        const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === tab.url);
        if (!contents) throw new Error("Missing split code fixture.");
        await waitForPresentedFrame(contents);
        const password = await prepareSplit(tab.id, {
          method: "password",
          targets: [{ kind: "css", selector: "#split-password" }],
          submission: "click",
          submitTarget: { kind: "css", selector: "#split-sign-in" },
        });
        if (!password.vaultFillable) {
          password.cancel();
          throw new Error("The split code fixture's password field was not vault-fillable.");
        }
        if ((await runCauseEffect(password.submit("fixture-split-password-640213", true))) !== "submitted")
          throw new Error("The saved password fill before the split code did not navigate.");
        if (new URL(contents.getURL()).pathname !== path) throw new Error(`The password step did not open ${path}.`);
        await waitForPresentedFrame(contents);
        if (path === "/split-code") {
          // Only an authenticator code in one target for each digit can use the group rule.
          for (const args of [
            { ...splitGroup, method: "otp" },
            { ...splitGroup, targets: splitDigits.slice(0, 1) },
          ]) {
            const other = await prepareSplit(tab.id, args);
            other.cancel();
            if (other.vaultFillable)
              throw new Error(`A split code group was vault-fillable for ${JSON.stringify(args)}.`);
          }
          const failure = await prepareSplit(tab.id, { ...splitGroup, digits: 7 }).then(
            (handoff) => {
              handoff.cancel();
              return false;
            },
            () => true,
          );
          if (!failure) throw new Error("Six digit targets for a 7-digit code were accepted.");
          checks.push("/split-code: otp, one target, or a digit count unlike the targets gives no group");
        }
        const handoff = await prepareSplit(tab.id, {
          ...splitGroup,
          submission: "click",
          submitTarget: { kind: "css", selector: "#split-continue" },
        });
        if (!handoff.vaultFillable) {
          handoff.cancel();
          throw new Error(`The split code group of ${path} was not vault-fillable after a saved password.`);
        }
        const result = await runCauseEffect(handoff.submit("518302", true));
        const snapshot = await runCauseEffect(browser.snapshot(tab.id));
        if (JSON.stringify(snapshot).includes("518302")) throw new Error("A split vault code reached a snapshot.");
        if (new URL(snapshot.url).pathname !== end || result !== outcome)
          throw new Error(
            `A split vault code in ${path} reached ${snapshot.url} (${result}), not ${end} (${outcome}).`,
          );
        checks.push(`${path}: split vault code ${outcome === "submitted" ? "signs in" : "in a GET URL is blocked"}`);
        if (path === "/split-code") {
          // The code used the saved password's step. A second group on the same origin goes to the card.
          await contents.loadURL("https://authentication.openbot.test/split-code");
          const second = await prepareSplit(tab.id, splitGroup);
          second.cancel();
          if (second.vaultFillable) throw new Error("A second split code group used the same saved password fill.");
          checks.push("/split-code: a second split code group after one saved password goes to the card");
        }
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    // A target that changes while the secret waits takes no value, also when a page adds a submitter
    // that would send the form as GET.
    for (const [selector, method, change, path] of [
      ["#code", "otp", "document.querySelector('#code').name = 'changed'", "/login"],
      ["#otp-0", "authenticator", "document.querySelector('#otp-0').name = 'changed'", "/authenticator-fields"],
      [
        "#post-password",
        "password",
        "const button = document.createElement('button'); button.setAttribute('formmethod', 'get'); document.querySelector('#post-password').form.append(button)",
        "/login",
      ],
    ] as const) {
      const staleTab = await runCauseEffect(
        browser.open(`https://authentication.openbot.test${path}`, "secret-thread", "secret-agent"),
      );
      try {
        const handoff = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `stale-${selector}`,
            arguments: {
              tabId: staleTab.id,
              method,
              targets: [{ kind: "css", selector }],
              submission: "on_input",
            },
          }),
        );
        const contents = webContents.getAllWebContents().find((item) => item.getURL() === staleTab.url);
        if (!contents) throw new Error("Missing stale-target fixture.");
        await contents.executeJavaScript(`${change}; true`);
        let rejected = false;
        try {
          await runCauseEffect(handoff.submit(method === "password" ? "fixture-password-729104" : "729104", false));
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error(`A changed authentication target ${selector} was accepted.`);
        if ((await contents.executeJavaScript(`document.querySelector('${selector}').value`)) !== "")
          throw new Error(`A changed authentication target ${selector} received a value.`);
        checks.push(`${selector}: changed target receives no secret`);
      } finally {
        await runCauseEffect(browser.close(staleTab.id));
      }
    }
    // A wrong target names itself and the reason, so the agent can correct the request.
    for (const [targets, submitTarget, expected] of [
      [
        [{ kind: "css", selector: "#password" }],
        { kind: "css", selector: "#missing-submit" },
        "submitTarget: No element matches CSS selector: #missing-submit. Correct",
      ],
      [[{ kind: "css", selector: "#submit" }], { kind: "css", selector: "#submit" }, "The field target is not"],
      [[{ kind: "css", selector: "#password" }], undefined, "submission=click needs submitTarget"],
    ] as const) {
      const wrongTab = await runCauseEffect(
        browser.open("https://authentication.openbot.test/login", "secret-thread", "secret-agent"),
      );
      try {
        const failure = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `wrong-${expected}`,
            arguments: {
              tabId: wrongTab.id,
              method: "password",
              targets,
              submission: "click",
              ...(submitTarget ? { submitTarget } : {}),
            },
          }),
        ).then(
          () => undefined,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        if (!failure?.includes(expected))
          throw new Error(`A wrong authentication target gave an unclear error: ${failure ?? "none"}`);
      } finally {
        await runCauseEffect(browser.close(wrongTab.id));
      }
    }
    // One saved password fills a sign-up form's password and its confirmation, and the form sends. A
    // text field cannot take the second copy (#6333).
    let vaultFillable = false;
    const signup: Array<{ confirm: string; result: string; path: string }> = [];
    for (const [confirm, expected] of [
      ["#confirm", "submitted"],
      ["#name", "must both be password fields"],
    ] as const) {
      const signupTab = await runCauseEffect(
        browser.open("https://authentication.openbot.test/signup", "secret-thread", "secret-agent"),
      );
      try {
        const signupContents = webContents.getAllWebContents().find((item) => item.getURL() === signupTab.url);
        if (!signupContents) throw new Error("Missing sign-up fixture.");
        await waitForPresentedFrame(signupContents);
        const result = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `signup-${confirm}`,
            arguments: {
              tabId: signupTab.id,
              method: "password",
              targets: [
                { kind: "css", selector: "#password" },
                { kind: "css", selector: confirm },
              ],
              submission: "click",
              submitTarget: { kind: "css", selector: "#submit" },
            },
          }),
        ).then(
          async (handoff) => {
            vaultFillable ||= handoff.vaultFillable;
            return runCauseEffect(handoff.submit(vaultPassword, true));
          },
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        const snapshot = await runCauseEffect(browser.snapshot(signupTab.id));
        signup.push({ confirm, result, path: new URL(snapshot.url).pathname });
        if (!result.includes(expected) || (expected === "submitted") !== snapshot.url.endsWith("/complete"))
          throw new Error(`A sign-up fill with ${confirm} gave ${result} at ${snapshot.url}.`);
        if (JSON.stringify(snapshot).includes(vaultPassword)) throw new Error("A sign-up password reached a snapshot.");
      } finally {
        await runCauseEffect(browser.close(signupTab.id));
      }
    }
    if (!vaultFillable) throw new Error("A sign-up password and confirmation were not vault-fillable.");
    await mkdir(".openbot-build", { recursive: true });
    await writeFile(
      ".openbot-build/browser-secret-confirm-password.json",
      JSON.stringify({ status: "passed", vaultFillable, signup }, null, 2),
    );
    // A sign-in that answers in the same document keeps its answer: OpenBot empties the field and its
    // value attribute, and does not load the page again (#7564).
    const mirroredTab = await runCauseEffect(
      browser.open("https://authentication.openbot.test/mirrored", "secret-thread", "secret-agent"),
    );
    try {
      const mirroredContents = webContents.getAllWebContents().find((item) => item.getURL() === mirroredTab.url);
      if (!mirroredContents) throw new Error("Missing mirrored value fixture.");
      await waitForPresentedFrame(mirroredContents);
      const handoff = await runCauseEffect(
        browser.prepareSecret({
          namespace: "openbot_browser",
          tool: "submit_secret",
          threadId: "secret-thread",
          ownerAgentId: "secret-agent",
          turnId: "secret-turn",
          callId: "mirrored-value",
          arguments: {
            tabId: mirroredTab.id,
            method: "password",
            targets: [{ kind: "css", selector: "#password" }],
            submission: "click",
            submitTarget: { kind: "css", selector: "#submit" },
          },
        }),
      );
      const secret = "fixture-password-385617";
      const submission = await runCauseEffect(handoff.submit(secret, false));
      const page = z
        .object({ answer: z.string(), value: z.string(), attribute: z.string().nullable() })
        .parse(
          await mirroredContents.executeJavaScript(
            "({ answer: document.querySelector('#answer').textContent, value: document.querySelector('#password').value, attribute: document.querySelector('#password').getAttribute('value') })",
            true,
          ),
        );
      const snapshot = JSON.stringify(await runCauseEffect(browser.snapshot(mirroredTab.id)));
      const report = {
        status:
          submission === "submitted" &&
          mirroredPageLoads === 1 &&
          page.answer === "Wrong password" &&
          page.value === "" &&
          !page.attribute &&
          !snapshot.includes(secret)
            ? "passed"
            : "issues_found",
        submission,
        pageLoads: mirroredPageLoads,
        answerKept: page.answer === "Wrong password",
        fieldEmpty: page.value === "" && !page.attribute,
        snapshotHasValue: snapshot.includes(secret),
      };
      await mkdir(".openbot-build", { recursive: true });
      await writeFile(".openbot-build/browser-secret-mirrored-value.json", JSON.stringify(report, null, 2));
      if (report.status !== "passed")
        throw new Error(`A same-document sign-in lost its answer: ${JSON.stringify(report)}`);
    } finally {
      await runCauseEffect(browser.close(mirroredTab.id));
    }
    // A page that keeps a copy of the password stays open with its dialog and its other fields
    // (#9643). Snapshots and the tab list hide the value, and no image of the tab is taken.
    const modalTab = await runCauseEffect(
      browser.open("https://authentication.openbot.test/modal", "secret-thread", "secret-agent"),
    );
    try {
      const modalContents = webContents.getAllWebContents().find((item) => item.getURL() === modalTab.url);
      if (!modalContents) throw new Error("Missing dialog fixture.");
      await waitForPresentedFrame(modalContents);
      await modalContents.executeJavaScript(
        "document.querySelector('#verify').showModal(); document.querySelector('#code').value = '482913';",
        true,
      );
      const handoff = await runCauseEffect(
        browser.prepareSecret({
          namespace: "openbot_browser",
          tool: "submit_secret",
          threadId: "secret-thread",
          ownerAgentId: "secret-agent",
          turnId: "secret-turn",
          callId: "dialog-value",
          arguments: {
            tabId: modalTab.id,
            method: "password",
            targets: [{ kind: "css", selector: "#password" }],
            submission: "on_input",
          },
        }),
      );
      const secret = "fixture-password-964301";
      const submission = await runCauseEffect(handoff.submit(secret, false));
      const page = z
        .object({ open: z.boolean(), code: z.string(), copy: z.string().optional() })
        .parse(
          await modalContents.executeJavaScript(
            "({ open: document.querySelector('#verify').open, code: document.querySelector('#code').value, copy: document.querySelector('#strength').dataset.value })",
            true,
          ),
        );
      const read = await runCauseEffect(browser.snapshot(modalTab.id));
      const snapshot = JSON.stringify(read);
      const listed = JSON.stringify(browser.listTabs().find((tab) => tab.id === modalTab.id));
      // The page keeps a copy, so a query of its raw text could find the value one part at a time.
      // A ref from a snapshot still works.
      const tool = (name: string, args: DynamicToolCallParams["arguments"]) =>
        runCauseEffect(
          browser.handleDynamicTool({
            namespace: "openbot_browser",
            tool: name,
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `dialog-${name}`,
            arguments: args,
          }),
        ).then(
          (result) => result.success,
          () => false,
        );
      const partialWaitRefused = !(await tool("wait_for", {
        tabId: modalTab.id,
        text: secret.slice(0, 4),
        timeoutMs: 1_000,
      }));
      const cssTargetRefused = !(await tool("click", {
        tabId: modalTab.id,
        target: { kind: "css", selector: `[data-value^="${secret.slice(0, 4)}"]` },
      }));
      const validate = read.elements.find((element) => element.name === "Validate");
      const refClickWorks =
        validate !== undefined &&
        (await tool("click", {
          tabId: modalTab.id,
          target: { kind: "ref", ref: validate.ref, revision: read.revision },
        }));
      const screenshotRefused = await runCauseEffect(browser.screenshot(modalTab.id)).then(
        () => false,
        () => true,
      );
      const report = {
        status:
          submission === "submitted" &&
          modalPageLoads === 1 &&
          page.open &&
          page.code === "482913" &&
          page.copy === secret &&
          !snapshot.includes(secret) &&
          !listed.includes(secret) &&
          screenshotRefused &&
          partialWaitRefused &&
          cssTargetRefused &&
          refClickWorks
            ? "passed"
            : "issues_found",
        submission,
        pageLoads: modalPageLoads,
        dialogOpen: page.open,
        codeKept: page.code === "482913",
        pageKeepsCopy: page.copy === secret,
        snapshotHasValue: snapshot.includes(secret),
        tabListHasValue: listed.includes(secret),
        screenshotRefused,
        partialWaitRefused,
        cssTargetRefused,
        refClickWorks,
      };
      await mkdir(".openbot-build", { recursive: true });
      await writeFile(".openbot-build/browser-secret-dialog.json", JSON.stringify(report, null, 2));
      if (report.status !== "passed")
        throw new Error(`A password fill in a dialog lost the dialog or showed the value: ${JSON.stringify(report)}`);
    } finally {
      await runCauseEffect(browser.close(modalTab.id));
    }
    // A submission that leaves the value in the page keeps the page, and no live view shows it. The
    // live view of a takeover loads the page again, so a person on another computer can sign in by
    // hand and never sees the value.
    const stuckTab = await runCauseEffect(
      browser.open("https://authentication.openbot.test/stuck", "secret-thread", "secret-agent"),
    );
    try {
      const stuckContents = webContents.getAllWebContents().find((item) => item.getURL() === stuckTab.url);
      if (!stuckContents) throw new Error("Missing takeover view fixture.");
      const handoff = await runCauseEffect(
        browser.prepareSecret({
          namespace: "openbot_browser",
          tool: "submit_secret",
          threadId: "secret-thread",
          ownerAgentId: "secret-agent",
          turnId: "secret-turn",
          callId: "takeover-view",
          arguments: {
            tabId: stuckTab.id,
            method: "password",
            targets: [{ kind: "css", selector: "#password" }],
            submission: "on_input",
          },
        }),
      );
      const secret = "fixture-password-640271";
      const loadsBefore = stuckPageLoads;
      const submission = await runCauseEffect(handoff.submit(secret, false)).catch(() => "failed" as const);
      const keptAfterSubmit = stuckPageLoads === loadsBefore;
      const refused = await runCauseEffect(browser.startView(stuckTab.id, () => {})).then(
        async (stop) => {
          await runCauseEffect(stop());
          return false;
        },
        () => true,
      );
      await runCauseEffect(browser.beginTakeover(stuckTab.id));
      let frames = 0;
      const stopView = await runCauseEffect(
        browser.startView(stuckTab.id, () => {
          frames += 1;
        }),
      );
      try {
        const deadline = Date.now() + 10_000;
        while (frames === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        await runCauseEffect(stopView());
      }
      const page = await stuckContents.executeJavaScript(
        "JSON.stringify([document.title, document.querySelector('#password')?.value ?? null, document.body.innerText])",
        true,
      );
      browser.endTakeover(stuckTab.id);
      const report = {
        status:
          submission === "submitted" && keptAfterSubmit && refused && frames > 0 && !page.includes(secret)
            ? "passed"
            : "issues_found",
        submission,
        keptAfterSubmit,
        viewRefusedBeforeTakeover: refused,
        takeoverViewFrames: frames > 0,
        secretInPage: page.includes(secret),
      };
      await mkdir(".openbot-build", { recursive: true });
      await writeFile(".openbot-build/browser-secret-takeover-view.json", JSON.stringify(report, null, 2));
      if (report.status !== "passed")
        throw new Error(`The takeover view of a protected tab is wrong: ${JSON.stringify(report)}`);
    } finally {
      await runCauseEffect(browser.close(stuckTab.id));
    }
    // A saved login that fails keeps the tab protected. When its card ends, by a cancel, a stop or the
    // end of a routine, the tab must be free again: also when the page cannot load again, and also
    // when the card ends while the fill still runs. Until then, the agent can still close the tab (#9883).
    const lostResults: Record<string, { passed: boolean; [detail: string]: boolean | number | string }> = {};
    for (const ending of ["after-fill", "during-fill"] as const) {
      lostPageOffline = false;
      const lostTab = await runCauseEffect(
        browser.open("https://authentication.openbot.test/lost", "secret-thread", "secret-agent"),
      );
      try {
        const lostContents = webContents.getAllWebContents().find((item) => item.getURL() === lostTab.url);
        if (!lostContents) throw new Error("Missing failed fill fixture.");
        const handoff = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `lost-${ending}`,
            arguments: {
              tabId: lostTab.id,
              method: "password",
              targets: [{ kind: "css", selector: "#password" }],
              // The after-fill case clicks a button that stays disabled, so its fill fails after the value went in.
              ...(ending === "after-fill"
                ? { submission: "click", submitTarget: { kind: "css", selector: "#lost-submit" } }
                : { submission: "on_input" }),
            },
          }),
        );
        const loadsBefore = lostPageLoads;
        const title = () => browser.listTabs().find((tab) => tab.id === lostTab.id)?.title;
        let protectedAfterFill = false;
        if (ending === "after-fill") {
          // The fork frees the tab at once when a failed fill leaves no value in the page (3290aca164).
          // A failed fill whose value stays in the page, and whose reload fails offline, keeps the protection.
          lostPageOffline = true;
          await runCauseEffect(handoff.submit("fixture-password-118204", true)).catch(() => undefined);
          protectedAfterFill = title() === "Secure authentication";
          await runCauseEffect(browser.beginTakeover(lostTab.id));
          browser.endTakeover(lostTab.id);
        } else {
          // The page renders its field again while the saved login is read, so the fill fails.
          await lostContents.executeJavaScript("document.querySelector('#password').id = 'rendered-again'", true);
          const fill = runCauseEffect(handoff.submit("fixture-password-118204", true)).catch(() => undefined);
          browser.endTakeover(lostTab.id);
          await fill;
          protectedAfterFill = true;
        }
        const deadline = Date.now() + 15_000;
        while (title() === "Secure authentication" && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        const released = title() !== "Secure authentication";
        const snapshotWorks = await runCauseEffect(browser.snapshot(lostTab.id)).then(
          () => true,
          () => false,
        );
        const closed = await runCauseEffect(
          browser.handleDynamicTool({
            namespace: "openbot_browser",
            tool: "close_tab",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `lost-close-${ending}`,
            arguments: { tabId: lostTab.id },
          }),
        ).then(
          (result) =>
            result.success || result.contentItems.map((item) => (item.type === "inputText" ? item.text : "")).join(" "),
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        lostResults[ending] = {
          passed: protectedAfterFill && released && snapshotWorks && closed === true,
          protectedAfterFill,
          reloadAttempts: lostPageLoads - loadsBefore,
          released,
          snapshotWorks,
          closed,
        };
      } finally {
        await runCauseEffect(browser.close(lostTab.id));
      }
    }
    // A protected tab that nothing releases: the agent can close it, and no other tool reads it.
    lostPageOffline = false;
    const heldTab = await runCauseEffect(
      browser.open("https://authentication.openbot.test/lost", "secret-thread", "secret-agent"),
    );
    try {
      const heldContents = webContents.getAllWebContents().find((item) => item.getURL() === heldTab.url);
      if (!heldContents) throw new Error("Missing failed fill fixture.");
      const handoff = await runCauseEffect(
        browser.prepareSecret({
          namespace: "openbot_browser",
          tool: "submit_secret",
          threadId: "secret-thread",
          ownerAgentId: "secret-agent",
          turnId: "secret-turn",
          callId: "held-fill",
          arguments: {
            tabId: heldTab.id,
            method: "password",
            targets: [{ kind: "css", selector: "#password" }],
            // The button stays disabled, so the fill fails after the value went in.
            submission: "click",
            submitTarget: { kind: "css", selector: "#lost-submit" },
          },
        }),
      );
      const tool = (name: string, args: DynamicToolCallParams["arguments"]) =>
        runCauseEffect(
          browser.handleDynamicTool({
            namespace: "openbot_browser",
            tool: name,
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `held-${name}`,
            arguments: args,
          }),
        ).then(
          (result) =>
            result.success || result.contentItems.map((item) => (item.type === "inputText" ? item.text : "")).join(" "),
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      const protectedError = (result: unknown) =>
        typeof result === "string" && result.includes("protected during authentication");
      // While the card is open, the tab stays: a close would leave the card on a tab that is gone.
      const closeWithCardRefused = protectedError(await tool("close_tab", { tabId: heldTab.id }));
      // The failed fill leaves the value in the page and its reload fails, so the protection stays
      // (fork 3290aca164).
      lostPageOffline = true;
      await runCauseEffect(handoff.submit("fixture-password-118204", true)).catch(() => undefined);
      const held = browser.listTabs().find((tab) => tab.id === heldTab.id)?.title === "Secure authentication";
      const snapshotRefused = protectedError(await tool("snapshot", { tabId: heldTab.id }));
      const navigateRefused = protectedError(await tool("navigate", { tabId: heldTab.id, direction: "reload" }));
      const closed = await tool("close_tab", { tabId: heldTab.id });
      lostResults.held = {
        passed:
          held &&
          closeWithCardRefused &&
          snapshotRefused &&
          navigateRefused &&
          closed === true &&
          !browser.listTabs().some((tab) => tab.id === heldTab.id),
        held,
        closeWithCardRefused,
        snapshotRefused,
        navigateRefused,
        closed,
      };
    } finally {
      await runCauseEffect(browser.close(heldTab.id));
    }
    const lostReport = {
      status: Object.values(lostResults).every((result) => result.passed) ? "passed" : "issues_found",
      ...lostResults,
    };
    await mkdir(".openbot-build", { recursive: true });
    await writeFile(".openbot-build/browser-secret-ended-fill.json", JSON.stringify(lostReport, null, 2));
    if (lostReport.status !== "passed")
      throw new Error(`A tab stayed locked after its saved login ended: ${JSON.stringify(lostReport)}`);
    await runFrameScenario(browser);
    const directory = join(process.cwd(), ".openbot-build", "browser-secret");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "smoke.json"), JSON.stringify({ passed: true, checks, cliCommands }, null, 2));
    process.stdout.write("BrowserHost: secure password, OTP and authenticator handoff passed.\n");
  } finally {
    protocol.unhandle("https");
  }
}
