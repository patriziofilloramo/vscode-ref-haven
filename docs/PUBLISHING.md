# Public publishing checklist

RefHaven is deliberately protected from publication to the npm registry by
`private: true`. That flag does not prevent Visual Studio Marketplace
packaging: `npm run package:release` validates the public metadata and creates
the release VSIX directly with VSCE. Keep the protection in the committed
manifest; a release must not require a temporary or dirty manifest edit.

Internal VSIX packaging remains available through `npm run package`.

## Required organisation inputs

Before changing the release safeguards, obtain:

- the verified Visual Studio Marketplace publisher ID;
- the legal owner and copyright notice;
- the approved distribution license and matching `LICENSE` text;
- the canonical repository URL;
- the public product or repository homepage URL;
- the public issue tracker or support URL;
- the security-reporting contact and response process;
- written approval of the product name for the target jurisdictions.

Do not infer these values from a Git author identity, workstation account,
temporary repository location, or internal email address.

## Name and brand review

A preliminary exact-name web and extension-marketplace search performed on
2026-07-16 found no obvious conflicting software listing. This is only an
initial engineering check, not trademark clearance.

The final review should search relevant trademark registers and similar names,
including phonetic, visual, and meaning-based variants for related software
and developer-tool services. The United States Patent and Trademark Office
explains that likelihood of confusion can result from similarity in sound,
appearance, meaning, or commercial impression together with related goods or
services:

<https://www.uspto.gov/trademarks/search/likelihood-confusion>

Keep marketplace copy focused on RefHaven's own capabilities. Do not use
third-party brands in the extension name, identifier, keywords, public
documentation, screenshots, command IDs, or marketing artwork.

## Provenance and licensing

- Review [IP-PROVENANCE.md](../IP-PROVENANCE.md) and
  [ADR-001](ADR-001-clean-implementation.md) against the final repository
  history.
- Confirm that the icon, screenshots, and future marketing assets are original
  or have documented distribution rights.
- Once the public repository URL exists, add the logo to the README head
  (`assets/refhaven-logo.svg`); vsce rejects relative README images while the
  manifest has no repository, so the mark currently ships only as the icon.
- Select the project license with the legal owner; do not copy a third-party
  license merely because another product uses it.
- Add the exact copyright and attribution notices required by any approved
  external material.
- Confirm compliance with the current Visual Studio Marketplace publisher
  agreement:
  <https://learn.microsoft.com/en-us/legal/marketplace/msft-publisher-agreement-september-2025>

## Metadata changes

The repository already carries the public identity: publisher
`patriziofilloramo`, the MIT `LICENSE`, and the `repository`, `homepage`, and
`bugs` metadata. Before the first Marketplace release, still confirm:

1. the `patriziofilloramo` publisher ID is registered and verified on the
   Marketplace under the owning account;
2. `private` remains `true` in the release commit and build, blocking accidental
   `npm publish`; VSCE packaging is independent of npm registry publication,
   and `npm run marketplace:check` rejects a missing or disabled safeguard;
3. **private vulnerability reporting is enabled** on the GitHub repository
   (Settings → Advanced Security → Private vulnerability reporting), because
   `SECURITY.md` directs reporters there;
4. the version in `package.json` and `package-lock.json` matches the top entry
   of `CHANGELOG.md`.

Then update the manifest unit test if any of the protected values change.

## Release gates

Run from a clean checkout using the supported Node version:

```text
npm ci
npm run format:check
npm run lint
npm run compile
npm run quality
npm run test:unit
npm run test:extension
npm audit --audit-level=low
npm audit --omit=dev --audit-level=low
npm audit signatures
npm ls --omit=dev --depth=0
npm run marketplace:check
npm run package:release
npx vsce ls --no-dependencies
```

Inspect the final VSIX contents, install it into a clean VS Code profile, and
repeat the privacy-critical smoke tests in [TEST-MATRIX.md](TEST-MATRIX.md).
Publish only the reviewed artifact produced from the tagged commit.
