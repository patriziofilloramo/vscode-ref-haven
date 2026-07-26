# Dependency policy

RefHaven ships with zero production dependencies. All direct packages are development-only, exact-pinned in `package.json`, integrity-pinned in `package-lock.json`, and omitted from the VSIX. Source maps remain available for local development but are excluded from the package, which contains only compiled JavaScript and documentation.

Unit tests also require the root package name and release version in
`package-lock.json` to match `package.json`, preventing stale lockfile metadata
from reaching a packaged batch.

## Direct development dependencies

| Package                                      | Purpose                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `typescript`, `@types/node`, `@types/vscode` | Strict compilation against the supported Node 20 and VS Code 1.105 APIs |
| `eslint`, `@eslint/js`, `typescript-eslint`  | Type-aware static analysis                                              |
| `prettier`                                   | Deterministic formatting                                                |
| `mocha`, `@types/mocha`                      | Unit and Extension Host test execution                                  |
| `@vscode/test-electron`                      | Official VS Code Extension Host launcher                                |
| `@vscode/vsce`                               | Official VSIX packager                                                  |

The project-owned `scripts/clean.mjs` replaces `rimraf`. The project-owned Extension Host runner replaces `@vscode/test-cli`; both removals reduce transitive supply-chain surface without duplicating complex platform logic.

## Intentional compatibility pins

- `@types/node` stays on Node 20 because `engines.node` is `>=20 <21`.
- `@types/vscode` stays on 1.105 because using newer declarations could accidentally ship APIs unavailable at the declared minimum VS Code version.
- `typescript` stays below 6.1 because the current `typescript-eslint` peer range does not support TypeScript 7.
- `@vscode/test-electron` stays on the latest 2.x release compatible with Node 20; 3.x requires Node 22.
- `mocha` stays on 11.3.0 while later 11.x versions resolve to a `diff` release covered by GHSA-73rr-hh4g-fpgx. Security takes precedence over version number.
- `brace-expansion` is centrally overridden to exact version 5.0.8 so all
  transitive consumers use one audited release instead of a floating range.
- `serialize-javascript` is centrally overridden to the current patched release instead of accepting Mocha's older transitive range.

## Release checks

Run all of the following before release:

```text
npm audit --audit-level=low
npm audit --omit=dev --audit-level=low
npm audit signatures
npm ls --omit=dev --depth=0
npm run test:unit
npm run test:extension
npm run lint
npm run compile
npm run quality
npm run format:check
npm run package
npx vsce ls --no-dependencies
```

An update is accepted only when the supported Node/VS Code matrix remains valid, the complete audit is clean, registry signatures verify, tests pass, and the packaged file list contains no dependency tree.

The quality guard also rejects runtime dependencies, non-exact direct
development pins or overrides, missing branding assets, oversized source
files, duplicated setting literals, duplicated full Git object-ID validators,
direct exception-message logging, and third-party branding or command
namespaces in public/runtime surfaces. These checks are deliberately
implemented with Node built-ins so the guard introduces no new supply-chain
surface.

For a public release, also run `npm run marketplace:check` and
`npm run package:release`. The readiness script uses Node built-ins and verifies
the final publisher, license file and expression, repository, homepage, support
URL, privacy notice, security policy, and provenance record. The current
pre-publication metadata intentionally makes that gate fail closed.
