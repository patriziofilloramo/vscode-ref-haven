import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Enforced data-egress guarantee.
 *
 * RefHaven's core promise is that repository data never leaves the workstation
 * except through the user's explicitly configured Git remote (opened in the
 * browser on an explicit command). This test turns that promise into a
 * build-enforced invariant: it fails the moment any source file gains a
 * network primitive, a code-execution primitive, telemetry, or an
 * unauthorized process or browser handoff.
 *
 * The extension ships as `tsc` output of `src/` with no bundler and zero
 * production dependencies (also asserted here), so scanning `src/` proves the
 * property for the shipped `dist/` bytes.
 */

const SRC_ROOT = resolve(__dirname, "../../../src");

/** Network and code-loading modules that must never be imported anywhere. */
const FORBIDDEN_MODULES = [
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "dns",
  "dns/promises",
  "inspector",
  "worker_threads",
  "cluster",
];

/**
 * Capabilities that legitimately exist but only in a single audited file.
 * A match anywhere else fails the guard.
 */
const CAPABILITY_ALLOWLIST: readonly {
  readonly file: string;
  readonly pattern: RegExp;
  readonly what: string;
}[] = [
  {
    file: "infrastructure/git/GitProcess.ts",
    pattern: /\bchild_process\b|\bexecFile\b|\bspawn\b/u,
    what: "process execution",
  },
  {
    file: "application/GitLabController.ts",
    pattern: /\bopenExternal\b/u,
    what: "browser handoff",
  },
];

/** Call and identifier patterns that must not appear in any source file. */
const FORBIDDEN_CALLS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "fetch()", pattern: /\bfetch\s*\(/u },
  { label: "WebSocket", pattern: /\bWebSocket\b/u },
  { label: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/u },
  { label: "sendBeacon", pattern: /\bsendBeacon\b/u },
  { label: "EventSource", pattern: /\bEventSource\b/u },
  { label: "eval()", pattern: /\beval\s*\(/u },
  { label: "new Function()", pattern: /\bnew\s+Function\s*\(/u },
  { label: "dynamic import()", pattern: /\bimport\s*\(/u },
  { label: "asExternalUri", pattern: /\basExternalUri\b/u },
  {
    label: "telemetry",
    pattern: /\bisTelemetryEnabled\b|\bcreateTelemetryLogger\b|TelemetryReporter/u,
  },
];

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

/** Removes comments so a prose mention of a primitive never trips the guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\n]*/gu, " ");
}

/** Matches ESM/CJS module specifiers for a given module name. */
function importPattern(moduleName: string): RegExp {
  const escaped = moduleName.replace(/[/]/gu, "\\/");
  return new RegExp(`(?:from|require\\s*\\(|import\\s*\\()\\s*['"](?:node:)?${escaped}['"]`, "u");
}

suite("data-egress guard", () => {
  const files = listSourceFiles(SRC_ROOT).map((path) => ({
    code: stripComments(readFileSync(path, "utf8")),
    raw: readFileSync(path, "utf8"),
    rel: relative(SRC_ROOT, path).replaceAll("\\", "/"),
  }));

  test("scans a non-trivial source tree", () => {
    assert.ok(
      files.length >= 40,
      `expected the full source tree, found ${files.length.toString()} files`,
    );
  });

  test("imports no network or code-loading module", () => {
    const offenders: string[] = [];
    for (const moduleName of FORBIDDEN_MODULES) {
      const pattern = importPattern(moduleName);
      for (const file of files) {
        if (pattern.test(file.raw)) offenders.push(`${file.rel} imports "${moduleName}"`);
      }
    }
    assert.deepEqual(offenders, [], `forbidden module imports:\n${offenders.join("\n")}`);
  });

  test("contains no network or code-execution primitive", () => {
    const offenders: string[] = [];
    for (const { label, pattern } of FORBIDDEN_CALLS) {
      for (const file of files) {
        if (pattern.test(file.code)) offenders.push(`${file.rel} uses ${label}`);
      }
    }
    assert.deepEqual(offenders, [], `forbidden primitives:\n${offenders.join("\n")}`);
  });

  test("confines process execution and browser handoff to their audited files", () => {
    const offenders: string[] = [];
    for (const { file, pattern, what } of CAPABILITY_ALLOWLIST) {
      let seenInOwner = false;
      for (const source of files) {
        if (!pattern.test(source.code)) continue;
        if (source.rel === file) seenInOwner = true;
        else offenders.push(`${what} appears in ${source.rel}; only ${file} may use it`);
      }
      assert.ok(seenInOwner, `expected ${file} to still contain its ${what} capability`);
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  test("ships zero production dependencies", () => {
    const manifest = JSON.parse(readFileSync(resolve(SRC_ROOT, "../package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly extensionDependencies?: readonly string[];
    };
    assert.deepEqual(manifest.dependencies ?? {}, {}, "RefHaven must have no runtime dependencies");
    assert.deepEqual(manifest.extensionDependencies ?? [], []);
  });
});
