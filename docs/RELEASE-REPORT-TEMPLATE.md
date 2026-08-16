# Release evidence report

Copy this file to a version-specific report outside the packaged extension, or
attach the completed content to the GitHub release preparation record. Do not
mark a row complete without reproducible evidence from the exact tagged VSIX.

## Identity

| Field                                     | Value |
| ----------------------------------------- | ----- |
| RefHaven version                          |       |
| Commit SHA and tag                        |       |
| VSIX filename                             |       |
| SHA-256 (identical result from two reads) |       |
| VS Code minimum/stable versions           |       |
| Git versions                              |       |
| Node/npm versions used to build           |       |
| CI run links                              |       |

## Automated gates

| Gate                                                  | Outcome and evidence |
| ----------------------------------------------------- | -------------------- |
| Clean checkout and `npm ci`                           |                      |
| Format, lint, compile, quality                        |                      |
| Unit tests                                            |                      |
| Extension Host tests                                  |                      |
| Annotation benchmark and hardware                     |                      |
| Full/runtime dependency audit and registry signatures |                      |
| Marketplace metadata check                            |                      |
| VSIX package listing and archive integrity            |                      |
| Reproducible SHA-256                                  |                      |

## Installed-VSIX manual matrix

| Scenario                                              | Windows | Linux | macOS | Evidence / limitation |
| ----------------------------------------------------- | ------- | ----- | ----- | --------------------- |
| Clean install, activation, primary commands           |         |       |       |                       |
| Whole-file blame: compact/detailed/grouped/repeated   |         |       |       |                       |
| Heatmap: all bands, dirty/empty/non-ASCII/large file  |         |       |       |                       |
| Heatmap legend counts, navigation, file/window/Escape |         |       |       |                       |
| Changes annotations: dirty buffer, reload, moved ref  |         |       |       |                       |
| Light, dark, high-contrast, high-contrast-light       |         |       |       |                       |
| Multi-root workspace                                  |         |       |       |                       |
| Folder nested below repository root                   |         |       |       |                       |
| Remote SSH with extension installed remotely          |         |       |       |                       |
| Commit search literal/regex/case modes                |         |       |       |                       |
| No background network activity                        |         |       |       |                       |

Record screenshots from the installed VSIX for the stable visual state. Include
the editor, relevant RefHaven control, active theme, and enough non-sensitive
fixture content to make the result auditable.

Use **Pass**, **Fail**, or **N/A** in every matrix cell. An **N/A** result
requires a written reason; an empty cell is missing evidence.

## Performance and limits

| Measurement                           | Result |
| ------------------------------------- | ------ |
| Activation time                       |        |
| 5,000-line annotation benchmark       |        |
| Large comparison responsiveness       |        |
| Repeated toggle/cancellation behavior |        |

## Decision

- Known limitations:
- Beta capabilities and missing gates:
- Feature-maturity changes:
- Final reviewer:
- Publication approved at:
