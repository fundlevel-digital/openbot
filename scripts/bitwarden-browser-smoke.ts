import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { webContents } from "electron";
import type { BrowserHost } from "../src/backend/browser-host";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { VaultLogin } from "../src/backend/password-vault";
import { passwordVaultRouter } from "../src/backend/password-vault-router";
import { BitwardenConnectorService } from "../src/main/bitwarden-connector-service";
import { waitForPresentedFrame } from "./browser-smoke-frames";

const ORIGIN = "https://authentication.openbot.test";
const ID = "12345678-1234-1234-1234-123456789abc";
const PASSWORD = "fixture-bitwarden-password";
const CODE = "73918246";

/** The page submits only if the browser received the expected fixture value. */
export function bitwardenLoginFixture(
  kind: "password" | "authenticator",
  field: "marked" | "totp" | "numeric" = "marked",
): Response {
  const expected = kind === "password" ? PASSWORD : CODE;
  const attributes =
    field === "totp"
      ? 'type="tel" name="totpPin" autocomplete="off"'
      : field === "numeric"
        ? 'type="text" inputmode="numeric" aria-label="Authenticator code"'
        : `type="${kind === "password" ? "password" : "text"}" autocomplete="${kind === "password" ? "current-password" : "one-time-code"}"`;
  return new Response(
    `<!doctype html><form method="post" action="/complete" onsubmit="if(document.querySelector('input').value!==${JSON.stringify(expected).replaceAll('"', "&quot;")}){event.preventDefault()}">
    <label>Secret<input id="vault-secret" ${attributes}></label>
    <button id="vault-submit">Sign in</button></form>`,
    { headers: { "Content-Type": "text/html" } },
  );
}

export async function runBitwardenBrowserSmoke(browser: BrowserHost): Promise<void> {
  let cliFails = false;
  let vaultLogins: VaultLogin[] = [];
  const connector = new BitwardenConnectorService({
    findCli: () => Effect.succeed({ executable: "/fixture/bw" }),
    runCli: async (_executable, args) => {
      if (cliFails) throw new Error("Fixture bw failure.");
      if (args[0] === "sync") return "Sync complete.";
      if (args[1] === "folders")
        return JSON.stringify([
          { id: null, name: "No Folder" },
          { id: "shared", name: "Shared with OpenBot" },
        ]);
      if (args[1] === "totp") return CODE;
      const item = {
        id: ID,
        name: "Fixture",
        type: 1,
        folderId: "shared",
        reprompt: 0,
        login: {
          username: "fixture@example.test",
          password: PASSWORD,
          totp: "fixture-seed",
          uris: [{ uri: "accounts.openbot.test", match: null }],
        },
      };
      return JSON.stringify(args[1] === "items" ? [item] : item);
    },
  });
  const vault = passwordVaultRouter([
    {
      prefix: "",
      name: "1Password",
      vault: { connected: () => false, loginsFor: () => Effect.succeed(null), secretFor: () => Effect.succeed(null) },
    },
    { prefix: "bitwarden:", name: "Bitwarden", vault: connector },
    {
      prefix: "openbot:",
      name: "the OpenBot Vault",
      vault: {
        connected: () => true,
        loginsFor: () => Effect.succeed(vaultLogins),
        secretFor: () => Effect.succeed(null),
      },
    },
  ]);
  const checks: string[] = [];
  try {
    await runCauseEffect(connector.connect("fixture-session-key"));
    const logins = await runCauseEffect(vault.loginsFor(ORIGIN));
    const login = logins?.[0];
    if (!login || JSON.stringify(logins).includes(PASSWORD) || JSON.stringify(logins).includes(CODE))
      throw new Error("Invalid vault metadata.");
    checks.push("metadata contains no credential values");
    for (const [method, field] of [
      ["password", "marked"],
      ["authenticator", "marked"],
      ["authenticator", "totp"],
      ["authenticator", "numeric"],
    ] as const) {
      const tab = await runCauseEffect(
        browser.open(`${ORIGIN}/bitwarden-${method}?field=${field}`, "secret-thread", "secret-agent"),
      );
      try {
        const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === tab.url);
        if (!contents) throw new Error("Missing Bitwarden fixture page.");
        await waitForPresentedFrame(contents);
        const prepared = await runCauseEffect(
          browser.prepareSecret({
            namespace: "openbot_browser",
            tool: "submit_secret",
            threadId: "secret-thread",
            ownerAgentId: "secret-agent",
            turnId: "secret-turn",
            callId: `bitwarden-${method}`,
            arguments: {
              tabId: tab.id,
              method,
              targets: [{ kind: "css", selector: "#vault-secret" }],
              submission: "click",
              submitTarget: { kind: "css", selector: "#vault-submit" },
            },
          }),
        );
        if (!prepared.vaultFillable || prepared.agentScriptedOrigin)
          throw new Error("Vault fixture is not safe to fill.");
        const value = await runCauseEffect(
          vault.secretFor(login.id, prepared.request.origin, method === "password" ? "password" : "totp"),
        );
        if (!value || (await runCauseEffect(prepared.submit(value, true))) !== "submitted")
          throw new Error("Bitwarden fixture did not submit.");
        const snapshot = await runCauseEffect(browser.snapshot(tab.id));
        if (!snapshot.url.endsWith("/complete") || JSON.stringify(snapshot).includes(value))
          throw new Error("Bitwarden sign-in failed or exposed its value.");
        checks.push(`${method} (${field}) signs in without digits and without exposing the value in the snapshot`);
      } finally {
        await runCauseEffect(browser.close(tab.id));
      }
    }
    cliFails = true;
    vaultLogins = [
      { id: "vault-login", title: "Vault fixture", username: "vault@example.test", hasOneTimePassword: false },
    ];
    const failed = await Effect.runPromise(Effect.result(vault.loginsFor(ORIGIN)));
    const failedStatus = connector.status();
    if (!Result.isFailure(failed) || failed.failure.sources?.join() !== "Bitwarden")
      throw new Error("The failed login list did not name Bitwarden.");
    if (failed.failure.logins?.map(({ id }) => id).join() !== "openbot:vault-login")
      throw new Error("A Bitwarden failure hid the OpenBot Vault login.");
    if (!failedStatus.connected || !failedStatus.error)
      throw new Error("The Bitwarden status did not show the failed read.");
    checks.push("a Bitwarden read failure names Bitwarden, keeps the other logins, and shows the error in its status");
    vaultLogins = [];
    cliFails = false;
    if ((await runCauseEffect(vault.loginsFor(ORIGIN)))?.[0]?.id !== login.id || connector.status().error !== null)
      throw new Error("A working Bitwarden read did not clear the error.");
    checks.push("the next working read lists the Bitwarden login and clears the error");
    await runCauseEffect(connector.disconnect());
    if (await runCauseEffect(vault.secretFor(login.id, ORIGIN, "password")))
      throw new Error("Disconnected vault returned a password.");
    checks.push("disconnect blocks further reads");
    const directory = join(process.cwd(), ".openbot-build", "bitwarden");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "browser-smoke.json"),
      JSON.stringify({ passed: true, source: "synthetic CLI", checks }, null, 2),
    );
  } finally {
    await runCauseEffect(connector.disconnect());
  }
}
