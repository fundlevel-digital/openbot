import { isBrowserProfileId } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { PreferenceFileFailure, readPreferenceFile } from "./preference-file";

/** Fork only. The server operator writes this file in the user-data folder; no UI writes it. */
export const NEW_AGENT_BROWSER_PROFILE_FILE = "openbot-new-agent-browser-profile-v1.json";

const logger = createOpenBotLogger("new-agent-browser-profile");

/**
 * Fork only. Gives the named browser profile that a new agent starts on, from
 * `{"version":1,"profileId":"<32 hex>"}` in `path`. The file is read for each new agent, so a change
 * applies to the next agent with no restart. A missing file gives `undefined`: the Shared profile, as
 * before. A file that is not valid, or an id that `profileExists` does not find, also gives
 * `undefined` and writes one warning. The result never fails, so the creation of the agent continues.
 */
export function newAgentBrowserProfile(
  path: string,
  profileExists: (profileId: string) => boolean,
): () => Effect.Effect<string | undefined> {
  return () =>
    readPreferenceFile(path, (parsed) => {
      if (!isDynamicRecord(parsed) || parsed.version !== 1 || !isBrowserProfileId(parsed.profileId))
        throw new Error("The file is not valid.");
      return parsed.profileId;
    }).pipe(
      Effect.flatMap((profileId) =>
        Effect.try({
          try: () => (profileExists(profileId) ? profileId : undefined),
          catch: (cause) => new PreferenceFileFailure({ cause }),
        }),
      ),
      Effect.tap((profileId) =>
        Effect.sync(() => {
          if (profileId === undefined)
            logger.warn(
              `${NEW_AGENT_BROWSER_PROFILE_FILE} names a browser profile that does not exist. The new agent uses the Shared profile.`,
            );
        }),
      ),
      Effect.catch(({ cause }) =>
        Effect.sync(() => {
          // Only the file name: the cause of a parse failure can quote the file text.
          if (!isMissingFileError(cause))
            logger.warn(
              `${NEW_AGENT_BROWSER_PROFILE_FILE} is not valid or cannot be read. The new agent uses the Shared profile.`,
            );
          return undefined;
        }),
      ),
    );
}
