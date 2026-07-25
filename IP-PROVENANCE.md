# Implementation and asset provenance

RefHaven is an independently maintained implementation built against public
Visual Studio Code extension APIs and the local Git command-line interface.
Its architecture, domain model, persistence, Git execution boundary, native
views, commands, tests, documentation, and packaging are maintained in this
repository.

No source code, branding, icons, screenshots, or other assets from third-party
Git products are included in RefHaven. Product and workflow research may
inform expected user behavior, but it does not imply source or asset reuse.
The RefHaven mark — a light-stroked shield sheltering a git-branch glyph with
an amber branch tip — is a project-specific original asset authored in this
repository as hand-written SVG (`assets/refhaven-logo.svg`, plus the
`currentColor` variant and rasterized icons derived from it). It contains no
third-party artwork, fonts, or traced material.

The clean-implementation decision and its technical rationale are recorded in
[ADR-001](docs/ADR-001-clean-implementation.md). The repository history
provides the change-by-change development record.

Any future proposal to reuse external code or assets must:

1. identify the exact source and version;
2. verify that its license permits the intended distribution;
3. preserve every required copyright, attribution, and license notice;
4. receive security and maintainability review; and
5. be recorded in a new or superseding architecture decision before merge.

This record documents project provenance and engineering policy. It is not a
substitute for legal review of a public release, product name, or license.
