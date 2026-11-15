/**
 * Host-realm profile tools (dev / parity). Production cells use {@link quickjs_code_mode}.
 */
import { CodeModeRunner } from "./code_mode.ts";
import {
  getProfileArgsSchema,
  getSummaryArgsSchema,
  queryProfilesArgsSchema,
} from "./profile_query_schema.ts";
import {
  getProfileTool,
  getSummaryTool,
  queryProfilesTool,
} from "./profile_query_tools.ts";

export const PROFILE_CODE_MODE_TOOL_NAMES = [
  "query_profiles",
  "get_profile",
  "get_profile_summary",
] as const;

/** Isolated host runner — never mixed into {@link createSportsdeskCodeModeHostRunner}. */
export function createProfileQueryHostRunner(): CodeModeRunner {
  const runner = new CodeModeRunner();
  registerProfileQueryCodeModeTools(runner);
  return runner;
}

export function registerProfileQueryCodeModeTools(
  runner: CodeModeRunner,
): void {
  runner.registerTool({
    name: "query_profiles",
    description:
      "Sortable customer profile rows by clv, vol, or sharp. Sentinel rows are omitted unless includeSentinels is exactly true; row.sentinel reflects profile sentinel state, not sort value.",
    parameters: queryProfilesArgsSchema,
    handler: async (args) =>
      queryProfilesTool.execute(queryProfilesArgsSchema.parse(args)),
  });

  runner.registerTool({
    name: "get_profile",
    description:
      "Returns one frozen profile snapshot by id (flags, vol, clv, sharp).",
    parameters: getProfileArgsSchema,
    handler: async (args) =>
      getProfileTool.execute(getProfileArgsSchema.parse(args)),
  });

  runner.registerTool({
    name: "get_profile_summary",
    description: "Aggregate desk snapshot deltas (deltaVol, deltaNet).",
    parameters: getSummaryArgsSchema,
    handler: async () => getSummaryTool.execute({}),
  });
}
