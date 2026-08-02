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

const FILTER_COMMAND_KEYS = ["clean", "smudge", "process"] as const;
const FILTER_CONFIG_KEY = /^filter\.([\s\S]+)\.(clean|smudge|process|required)$/iu;
const MAX_FILTER_CONFIG_ENTRIES = 512;
const MAX_FILTER_DRIVERS = 64;
const MAX_FILTER_DRIVER_LENGTH = 128;

const UNSAFE_FILTER_CONFIGURATION_MESSAGE =
  "Git filter configuration is too large or contains an unsupported driver name. RefHaven stopped before running the requested operation.";

/**
 * Git subcommands that cannot invoke a clean, smudge, process, or textconv
 * command under any argument, not merely the arguments RefHaven passes today:
 * they read or write refs, configuration, attribute metadata, or existing
 * objects without converting working-tree content. Subcommands that gain
 * conversion behaviour from a flag — `ls-files --eol`, `cat-file --filters`,
 * `hash-object` — are deliberately absent. Every other subcommand keeps the
 * per-command filter probe and neutralization.
 */
const FILTER_INERT_SUBCOMMANDS = new Set([
  "check-attr",
  "commit-tree",
  "config",
  "for-each-ref",
  "ls-tree",
  "rev-parse",
  "symbolic-ref",
  "update-ref",
  "write-tree",
]);

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

/**
 * Parses the effective filter configuration reported by `git config -z`.
 * Driver names are bounded and restricted to values that can safely be
 * round-tripped through a command-scoped `-c key=value` argument.
 */
export function parseConfiguredFilterDrivers(output: string): string[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) throw new Error(UNSAFE_FILTER_CONFIGURATION_MESSAGE);

  const keys = output.slice(0, -1).split("\0");
  if (keys.length > MAX_FILTER_CONFIG_ENTRIES) {
    throw new Error(UNSAFE_FILTER_CONFIGURATION_MESSAGE);
  }

  const drivers = new Set<string>();
  for (const key of keys) {
    const match = FILTER_CONFIG_KEY.exec(key);
    if (!match) continue;
    const driver = match[1];
    if (
      driver === undefined ||
      driver.length === 0 ||
      driver.length > MAX_FILTER_DRIVER_LENGTH ||
      !isSafeFilterDriver(driver)
    ) {
      throw new Error(UNSAFE_FILTER_CONFIGURATION_MESSAGE);
    }
    drivers.add(driver);
    if (drivers.size > MAX_FILTER_DRIVERS) {
      throw new Error(UNSAFE_FILTER_CONFIGURATION_MESSAGE);
    }
  }
  return [...drivers];
}

function isSafeFilterDriver(driver: string): boolean {
  if (driver.includes("=")) return false;
  for (const character of driver) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f) return false;
  }
  return true;
}

/**
 * Reports whether an argv provably cannot execute a content filter, so the
 * filter-configuration probe would protect nothing. The subcommand is located
 * by skipping only the leading flags RefHaven itself prepends (`-c key=value`
 * pairs and pathspec-mode toggles); any other leading flag fails closed and
 * keeps the probe.
 */
export function isFilterInertGitInvocation(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-c") {
      index += 1;
      continue;
    }
    if (argument === "--literal-pathspecs" || argument === "--no-literal-pathspecs") continue;
    if (argument === undefined || argument.length === 0 || argument.startsWith("-")) return false;
    return FILTER_INERT_SUBCOMMANDS.has(argument);
  }
  return false;
}

/** Applies command-scoped policy after all inherited and repository config. */
export function buildLocalOnlyGitArguments(
  args: readonly string[],
  filterDrivers: readonly string[] = [],
): string[] {
  const disabledFilterArguments = filterDrivers.flatMap((driver) => [
    ...FILTER_COMMAND_KEYS.flatMap((key) => ["-c", `filter.${driver}.${key}=`]),
    "-c",
    `filter.${driver}.required=false`,
  ]);
  return [
    "--literal-pathspecs",
    ...LOCAL_ONLY_CONFIG_ARGUMENTS,
    ...disabledFilterArguments,
    ...args,
  ];
}
