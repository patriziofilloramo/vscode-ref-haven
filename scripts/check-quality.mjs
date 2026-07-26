import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sourceFiles = collectFiles(join(root, "src"), ".ts");
const publicDocumentationFiles = collectFiles(join(root, "docs"), ".md").filter(
  (file) => relative(root, file).replaceAll("\\", "/") !== "docs/ADR-001-clean-implementation.md",
);
const violations = [];
const MAX_SOURCE_FILE_LINES = 1_200;
const publicSurfaceFiles = [
  ...collectFiles(root, ".md", false),
  ...publicDocumentationFiles,
  join(root, "package.json"),
  ...sourceFiles,
];
const thirdPartyBrandPattern = /\b(?:gitlens|gitkraken|gitless)\b/iu;
const thirdPartyCommandNamespacePattern = /\b(?:gitlens|gitkraken)\./iu;

if (manifest.dependencies !== undefined) {
  violations.push("package.json must not declare runtime dependencies.");
}

for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    violations.push(`Development dependency ${name} is not exact-pinned.`);
  }
}

for (const [name, version] of Object.entries(manifest.overrides ?? {})) {
  if (typeof version === "string" && !/^\d+\.\d+\.\d+$/u.test(version)) {
    violations.push(`Dependency override ${name} is not exact-pinned.`);
  }
}

const iconPath = join(root, manifest.icon ?? "");
if (!manifest.icon || !existsSync(iconPath) || statSync(iconPath).size === 0) {
  violations.push("The extension icon is missing or empty.");
}

for (const file of publicSurfaceFiles) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, "utf8");
  const relativePath = relative(root, file).replaceAll("\\", "/");
  if (thirdPartyBrandPattern.test(content)) {
    violations.push(`${relativePath} contains a third-party product or company name.`);
  }
  if (thirdPartyCommandNamespacePattern.test(content)) {
    violations.push(`${relativePath} contains a third-party command namespace.`);
  }
}

for (const file of sourceFiles) {
  const content = readFileSync(file, "utf8");
  const relativePath = relative(root, file).replaceAll("\\", "/");
  const lineCount = content.split(/\r?\n/u).length;
  if (lineCount > MAX_SOURCE_FILE_LINES) {
    violations.push(
      `${relativePath} has ${lineCount.toString()} lines; split files above ${MAX_SOURCE_FILE_LINES.toString()}.`,
    );
  }
  if (/logger\.(?:debug|info|warn|error)\([^\n]*(?:error|err)\.message/iu.test(content)) {
    violations.push(`${relativePath} logs an exception message directly.`);
  }
  if (
    relativePath !== "src/domain/gitObjectId.ts" &&
    /\[0-9a-f\][^/\n]{0,32}\{(?:40|40,64)\}/iu.test(content)
  ) {
    violations.push(`${relativePath} duplicates the full Git object-ID validator.`);
  }
}

const configurationOwners = new Set([
  "src/config/extensionConfiguration.ts",
  "src/config/extensionConfigurationSchema.ts",
]);
const configurationPrefix = `${manifest.name}.`;
const settingLiterals = Object.keys(manifest.contributes?.configuration?.properties ?? {})
  .filter((setting) => setting.startsWith(configurationPrefix))
  .map((setting) => setting.slice(configurationPrefix.length));
for (const file of sourceFiles) {
  const relativePath = relative(root, file).replaceAll("\\", "/");
  if (configurationOwners.has(relativePath)) continue;
  const content = readFileSync(file, "utf8");
  for (const setting of settingLiterals) {
    if (content.includes(`"${setting}"`) || content.includes(`'${setting}'`)) {
      violations.push(`${relativePath} duplicates the setting name ${setting}.`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Quality checks failed:\n- ${violations.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(
    `Quality checks passed for ${sourceFiles.length.toString()} TypeScript source files and ${Object.keys(manifest.devDependencies ?? {}).length.toString()} exact-pinned development dependencies.`,
  );
}

function collectFiles(directory, extension, recursive = true) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return recursive ? collectFiles(path, extension) : [];
    return extname(entry.name) === extension ? [path] : [];
  });
}
