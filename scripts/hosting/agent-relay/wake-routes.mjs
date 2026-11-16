// Lists the `message` wake routes that the listener's route file is missing and, with `--apply`,
// adds them. The default is a dry run that changes nothing.
//
// Each agent with a verified relay credential and no route gets a `message` route. The output also
// shows whether OpenBot's automation server lists the agent now: `localScripts: "on"` means the wake
// can go out; `"off_or_hidden"` means the route will wait until the owner turns "Local scripts" on
// for that agent (or restores a hidden agent); `"unknown"` means the server did not answer.
// The running listener reads the changed file at its next reload; it needs no restart. The listener
// can also find these routes itself when `wake.discoverAutomationRoutes` is true.
//
// Run as the OpenBot user: `sudo -H -u openbot node wake-routes.mjs [--apply]`.
import fs from "node:fs";
import path from "node:path";
import {
  atomicWrite,
  automationAgents,
  discoverMessageRoutes,
  loadStaticConfig,
  parseRoutes,
  readPrivate,
} from "./recipient-wake.mjs";

const apply = process.argv.includes("--apply");
const settings = loadStaticConfig();
const configPath = path.join(settings.stateDir, "config.json");
const config = fs.existsSync(configPath)
  ? JSON.parse(readPrivate(configPath))
  : { version: 1, cutoverAt: new Date().toISOString(), routes: [] };
const parsed = parseRoutes(config);
const found = discoverMessageRoutes(settings, new Set(parsed.routes.map((route) => route.botId)));
const exposed = await automationAgents(settings);
const localScripts = (botId) => {
  if (!exposed) return "unknown";
  return exposed.has(botId) ? "on" : "off_or_hidden";
};
const result = {
  mode: apply ? "apply" : "dry-run",
  configuredRoutes: parsed.routes.length,
  add: found.routes.map(({ botId, relayName }) => ({ botId, relayName, localScripts: localScripts(botId) })),
  skipped: found.skipped,
  written: false,
};
if (apply && found.routes.length) {
  const next = { ...config, routes: [...config.routes, ...found.routes] };
  // The listener refuses a bad file as a whole, so check the result before it replaces the old one.
  parseRoutes(next);
  atomicWrite(configPath, next);
  result.written = true;
}
console.log(JSON.stringify(result, null, 2));
