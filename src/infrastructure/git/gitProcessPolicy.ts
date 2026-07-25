const BLOCKED_INHERITED_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_GLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_INDEX_FILE",
  "GIT_LITERAL_PATHSPECS",
  "GIT_NAMESPACE",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_PROTOCOL",
  "GIT_PROXY_COMMAND",
  "GIT_QUARANTINE_PATH",
  "GIT_REDIRECT_STDERR",
  "GIT_REDIRECT_STDOUT",
  "GIT_SHALLOW_FILE",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_WORK_TREE",
] as const;

const LOCAL_ONLY_ENVIRONMENT = {
  GCM_INTERACTIVE: "Never",
  GIT_ALLOW_PROTOCOL: "",
  GIT_ASKPASS: "",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_TRACE: "0",
  GIT_TRACE2: "0",
  GIT_TRACE2_EVENT: "0",
  GIT_TRACE2_PERF: "0",
  GIT_TRACE_CURL: "0",
  GIT_TRACE_CURL_NO_DATA: "1",
  GIT_TRACE_PACKET: "0",
  GIT_TRACE_PERFORMANCE: "0",
  GIT_TRACE_REDACT: "1",
  GIT_TRACE_SETUP: "0",
  PAGER: "cat",
  SSH_ASKPASS_REQUIRE: "never",
} as const;

const LOCAL_ONLY_CONFIG_ARGUMENTS = [
  "-c",
  "protocol.allow=never",
  "-c",
  "core.fsmonitor=false",
] as const;

/**
 * Builds a deterministic Git environment that cannot prompt, trace repository
 * data, use a transport, or inherit a parent process' repository redirection.
 */
export function buildLocalOnlyGitEnvironment(
  inherited: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...inherited, ...LOCAL_ONLY_ENVIRONMENT };

  for (const name of BLOCKED_INHERITED_VARIABLES) Reflect.deleteProperty(environment, name);
  for (const name of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)) Reflect.deleteProperty(environment, name);
  }

  return environment;
}

/** Applies command-scoped policy after all inherited and repository config. */
export function buildLocalOnlyGitArguments(args: readonly string[]): string[] {
  return ["--literal-pathspecs", ...LOCAL_ONLY_CONFIG_ARGUMENTS, ...args];
}
