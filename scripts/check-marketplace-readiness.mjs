import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { URL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const violations = [];

if (manifest.private !== false) {
  violations.push("package.json must set private to false for a public release.");
}

if (
  typeof manifest.publisher !== "string" ||
  manifest.publisher.trim().length === 0 ||
  manifest.publisher === "local-development"
) {
  violations.push("package.json needs the final verified Marketplace publisher ID.");
}

if (
  typeof manifest.license !== "string" ||
  manifest.license.trim().length === 0 ||
  manifest.license === "UNLICENSED"
) {
  violations.push("package.json needs the approved SPDX license expression.");
}

for (const file of ["LICENSE", "SECURITY.md", "PRIVACY.md", "IP-PROVENANCE.md"]) {
  if (!existsSync(join(root, file))) {
    violations.push(`${file} is required for a public release.`);
  }
}

const securityPolicyPath = join(root, "SECURITY.md");
if (
  existsSync(securityPolicyPath) &&
  readFileSync(securityPolicyPath, "utf8").includes("PUBLICATION_INPUT_REQUIRED: security-contact")
) {
  violations.push("SECURITY.md still needs the organisation-approved reporting contact.");
}

if (!isRepositoryUrl(manifest.repository)) {
  violations.push("package.json needs the canonical repository URL.");
}

if (!isNonEmptyHttpUrl(manifest.homepage)) {
  violations.push("package.json needs the public product or repository homepage URL.");
}

if (!isNonEmptyHttpUrl(manifest.bugs?.url)) {
  violations.push("package.json needs the public issue or support URL in bugs.url.");
}

const publicFiles = [
  ...collectFiles(root, ".md", false),
  ...collectFiles(join(root, "docs"), ".md")
    .filter(
      (file) =>
        relative(root, file).replaceAll("\\", "/") !== "docs/ADR-001-clean-implementation.md",
    )
    .map((file) => relative(root, file)),
  ...collectFiles(join(root, "src"), ".ts").map((file) => relative(root, file)),
  "package.json",
];
const thirdPartyBrandPattern = /\b(?:gitlens|gitkraken|gitless)\b/iu;
for (const file of publicFiles) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  if (thirdPartyBrandPattern.test(readFileSync(path, "utf8"))) {
    violations.push(`${file} contains a third-party product or company name.`);
  }
}

if (violations.length > 0) {
  console.error(`Marketplace readiness check failed:\n- ${violations.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("Marketplace metadata and public-package safeguards are ready.");
}

function isNonEmptyHttpUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function isRepositoryUrl(repository) {
  if (typeof repository === "string") return isNonEmptyHttpUrl(repository);
  return repository !== null && typeof repository === "object" && isNonEmptyHttpUrl(repository.url);
}

function collectFiles(directory, extension, recursive = true) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return recursive ? collectFiles(path, extension) : [];
    return extname(entry.name) === extension ? [path] : [];
  });
}
