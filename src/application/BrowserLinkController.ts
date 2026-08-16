import * as vscode from "vscode";

import {
  EXTENSION_SETTING_DEFAULTS,
  EXTENSION_SETTINGS,
  extensionSettingPath,
  getExtensionConfiguration,
  readExtensionSetting,
} from "../config/extensionConfiguration";
import type { BranchRef, SavedComparisonV1 } from "../domain/comparison";
import type { CommitInfo } from "../domain/comparisonResult";
import {
  applyHostGrammarOverride,
  buildBrowserUrl,
  describeHostKind,
  parseApprovedBrowserOrigins,
  resolveBrowserProjects,
  supportsBrowserTarget,
  type BrowserProject,
  type BrowserTarget,
} from "../domain/browserLinks";
import { pathIdentityKey } from "../domain/pathValidation";
import {
  canonicalPathIdentityKey,
  discoverRepositories,
  fileExistsAtRevision,
  listComparisonRefs,
  listGitRemoteUrls,
  resolveRef,
} from "../infrastructure/git/GitCli";
import { resolveFileContextTarget, resolveKnownFileTarget } from "../ui/commands/fileContext";
import { openExternalUrl } from "../ui/externalLink";
import { showTransientSuccess } from "../ui/feedback";
import type { Logger } from "./Logger";

export class BrowserLinkController {
  public constructor(private readonly logger: Logger) {}

  public async configureApprovedOrigin(): Promise<void> {
    const configured = readExtensionSetting<unknown>(
      EXTENSION_SETTINGS.approvedBrowserOrigins,
      EXTENSION_SETTING_DEFAULTS.approvedBrowserOrigins,
    );
    if (!Array.isArray(configured)) {
      throw new Error("RefHaven approved browser origins must be an array.");
    }
    const value = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "https://gitlab.company.example:8443",
      prompt:
        configured.length > 1
          ? `${configured.length.toString()} origins are configured. Enter one exact origin to replace them, or leave empty to restore zero-config remote inference.`
          : "Enter one exact browser origin to enforce. Leave empty to restore zero-config remote inference.",
      title: "RefHaven: Configure Restricted Remote Origin",
      validateInput: (input) => {
        if (input.trim().length === 0) return undefined;
        try {
          parseApprovedBrowserOrigins([input]);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : "Enter an exact HTTP(S) origin.";
        }
      },
      value: configured.length === 1 && typeof configured[0] === "string" ? configured[0] : "",
    });
    if (value === undefined) return;

    const origin =
      value.trim().length === 0
        ? undefined
        : parseApprovedBrowserOrigins([value.trim()])[0]?.origin;
    const origins = origin ? [origin] : [];
    const target =
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await getExtensionConfiguration().update(
      EXTENSION_SETTINGS.approvedBrowserOrigins,
      origins,
      target,
    );
    showTransientSuccess(
      origin ? `Restricted remote origin set to ${origin}` : "Strict remote origin disabled",
    );
    this.logger.info("Updated restricted browser origin", {
      enabled: origins.length > 0,
      operation: "configureBrowserOrigin",
      scope: target === vscode.ConfigurationTarget.Workspace ? "workspace" : "global",
    });
  }

  public async openProject(candidate?: unknown): Promise<void> {
    const repositoryRoot = await this.resolveRepositoryRoot(candidate);
    if (!repositoryRoot) return;
    await this.open(repositoryRoot, { kind: "project" }, "openBrowserProject");
  }

  public async openCommit(repositoryRoot: unknown, commit: CommitInfo): Promise<void> {
    const root = await this.requireKnownRepository(repositoryRoot);
    const sha = await resolveRef(root, commit.sha);
    await this.open(root, { kind: "commit", sha }, "openBrowserCommit");
  }

  public async copyProjectUrl(candidate?: unknown): Promise<void> {
    const repositoryRoot = await this.resolveRepositoryRoot(candidate);
    if (!repositoryRoot) return;
    await this.copy(repositoryRoot, { kind: "project" }, "copyBrowserProjectUrl");
  }

  public async copyCommitUrl(repositoryRoot: unknown, commit: CommitInfo): Promise<void> {
    const root = await this.requireKnownRepository(repositoryRoot);
    const sha = await resolveRef(root, commit.sha);
    await this.copy(root, { kind: "commit", sha }, "copyBrowserCommitUrl");
  }

  public async copyBranchUrl(repositoryRoot: unknown, branch: BranchRef): Promise<void> {
    const root = await this.requireKnownRepository(repositoryRoot);
    const sha = await resolveRef(root, branch.fullName);
    await this.copy(root, { kind: "tree", sha }, "copyBrowserBranchUrl");
  }

  public async copyComparisonUrl(comparison: SavedComparisonV1): Promise<void> {
    const repositoryRoot = await this.requireKnownRepository(comparison.repository.rootPath);
    if (comparison.targetRef.kind === "workingTree") {
      void vscode.window.showInformationMessage(
        "Working Tree comparisons do not have an immutable remote revision.",
      );
      return;
    }
    const [baseSha, targetSha] = await Promise.all([
      resolveRef(repositoryRoot, comparison.baseRef.fullName),
      resolveRef(repositoryRoot, comparison.targetRef.fullName),
    ]);
    await this.copy(
      repositoryRoot,
      { baseSha, kind: "compare", targetSha },
      "copyBrowserComparisonUrl",
    );
  }

  public async copyFileUrl(candidate?: unknown): Promise<void> {
    const target = await resolveFileContextTarget(candidate);
    if (!target) throw new Error("Select a file inside a Git repository first.");
    const sha = await resolveRef(target.repositoryRoot, "HEAD");
    if (!(await fileExistsAtRevision(target.repositoryRoot, sha, target.filePath))) {
      void vscode.window.showInformationMessage(
        "This file is not available in HEAD and cannot be linked in the browser yet.",
      );
      return;
    }
    await this.copy(
      target.repositoryRoot,
      {
        filePath: target.filePath,
        kind: "file",
        sha,
        ...(selectedEditorLines(target.uri) ?? {}),
      },
      "copyBrowserFileUrl",
    );
  }

  public async openBranch(repositoryRoot: unknown, branch: BranchRef): Promise<void> {
    const root = await this.requireKnownRepository(repositoryRoot);
    const sha = await resolveRef(root, branch.fullName);
    await this.open(root, { kind: "tree", sha }, "openBrowserBranch");
  }

  public async openComparison(comparison: SavedComparisonV1): Promise<void> {
    const repositoryRoot = await this.requireKnownRepository(comparison.repository.rootPath);
    if (comparison.targetRef.kind === "workingTree") {
      void vscode.window.showInformationMessage(
        "Working Tree comparisons do not have an immutable remote revision.",
      );
      return;
    }
    const [baseSha, targetSha] = await Promise.all([
      resolveRef(repositoryRoot, comparison.baseRef.fullName),
      resolveRef(repositoryRoot, comparison.targetRef.fullName),
    ]);
    await this.open(
      repositoryRoot,
      { baseSha, kind: "compare", targetSha },
      "openBrowserComparison",
    );
  }

  public async openLocalReference(candidate?: unknown): Promise<void> {
    const repositoryRoot = await this.resolveRepositoryRoot(candidate);
    if (!repositoryRoot) return;
    const refs = await listComparisonRefs(repositoryRoot);
    const selected = await vscode.window.showQuickPick(
      refs.map((ref) => ({
        description: referenceKindLabel(ref),
        label: ref.displayName,
        ref,
      })),
      {
        matchOnDescription: true,
        placeHolder: "Select a locally available branch, tag, or HEAD",
        title: "RefHaven: Open Local Reference in Browser",
      },
    );
    if (!selected) return;
    const sha = await resolveRef(repositoryRoot, selected.ref.fullName);
    await this.open(repositoryRoot, { kind: "tree", sha }, "openBrowserLocalReference");
  }

  public async openFile(candidate?: unknown): Promise<void> {
    const target = await resolveFileContextTarget(candidate);
    if (!target) throw new Error("Select a file inside a Git repository first.");
    const sha = await resolveRef(target.repositoryRoot, "HEAD");
    if (!(await fileExistsAtRevision(target.repositoryRoot, sha, target.filePath))) {
      void vscode.window.showInformationMessage(
        "This file is not available in HEAD and cannot be opened in the browser yet.",
      );
      return;
    }
    const lines = selectedEditorLines(target.uri);
    await this.open(
      target.repositoryRoot,
      {
        filePath: target.filePath,
        kind: "file",
        sha,
        ...(lines ?? {}),
      },
      "openBrowserFile",
    );
  }

  public async openFileAt(
    repositoryRoot: unknown,
    sha: unknown,
    filePath: unknown,
    startLine?: unknown,
    endLine?: unknown,
  ): Promise<void> {
    const target = await resolveKnownFileTarget(repositoryRoot, filePath);
    if (!target) throw new Error("The selected repository file is not available.");
    if (typeof sha !== "string") throw new Error("The selected remote revision is invalid.");
    const canonicalSha = await resolveRef(target.repositoryRoot, sha);
    if (!(await fileExistsAtRevision(target.repositoryRoot, canonicalSha, target.filePath))) {
      void vscode.window.showInformationMessage(
        "This file is not available at the selected Git revision.",
      );
      return;
    }
    await this.open(
      target.repositoryRoot,
      {
        filePath: target.filePath,
        kind: "file",
        sha: canonicalSha,
        ...validatedLines(startLine, endLine),
      },
      "openBrowserFile",
    );
  }

  public async openReference(candidate?: unknown): Promise<void> {
    const repositoryRoot = await this.resolveRepositoryRoot(candidate);
    if (!repositoryRoot) return;
    const value = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "#123 or !123",
      prompt: "Enter an issue or merge/pull request reference.",
      title: "RefHaven: Open Issue or Request Reference",
      validateInput: (input) =>
        /^[#!][1-9]\d*$/u.test(input.trim())
          ? undefined
          : "Use #123 for an issue or !123 for an MR.",
    });
    if (value === undefined) return;
    const reference = /^([#!])([1-9]\d*)$/u.exec(value.trim());
    const number = Number.parseInt(reference?.[2] ?? "", 10);
    if (!reference || !Number.isSafeInteger(number)) {
      throw new Error("The reference is invalid.");
    }
    await this.open(
      repositoryRoot,
      reference[1] === "#" ? { kind: "issue", number } : { kind: "mergeRequest", number },
      "openBrowserReference",
    );
  }

  /** Opens a `#123`/`!123` reference directly, e.g. from an autolinked commit message. */
  public async openReferenceAt(repositoryRoot: unknown, reference: unknown): Promise<void> {
    const root = await this.requireKnownRepository(repositoryRoot);
    const parsed =
      typeof reference === "string" ? /^([#!])([1-9]\d{0,9})$/u.exec(reference.trim()) : null;
    const number = Number.parseInt(parsed?.[2] ?? "", 10);
    if (!parsed || !Number.isSafeInteger(number) || number < 1) {
      throw new Error("The reference is invalid.");
    }
    await this.open(
      root,
      parsed[1] === "#" ? { kind: "issue", number } : { kind: "mergeRequest", number },
      "openBrowserReference",
    );
  }

  private async open(
    repositoryRoot: string,
    target: BrowserTarget,
    operation: string,
  ): Promise<void> {
    const url = await this.resolveUrl(repositoryRoot, target);
    if (!url) return;
    const opened = await openExternalUrl(url);
    if (!opened) throw new Error("VS Code could not open the validated browser URL.");
    // Non-blocking transparency: always show which origin was opened, which
    // matters most when the origin was inferred from the repository remote.
    showTransientSuccess(`Opened ${new URL(url).origin}`);
    this.logger.info("Opened validated browser URL", { operation });
  }

  private async copy(
    repositoryRoot: string,
    target: BrowserTarget,
    operation: string,
  ): Promise<void> {
    const url = await this.resolveUrl(repositoryRoot, target);
    if (!url) return;
    await vscode.env.clipboard.writeText(url);
    showTransientSuccess(`Copied ${new URL(url).origin} URL`);
    this.logger.info("Copied validated browser URL", { operation });
  }

  private async resolveUrl(repositoryRoot: string, target: BrowserTarget): Promise<string | null> {
    const project = await this.selectProject(repositoryRoot);
    if (!project) return null;
    const { hostKind } = project.browserOrigin;
    // A host RefHaven cannot address correctly gets no link at all. Guessing
    // produced valid-looking URLs that opened empty pages.
    if (!supportsBrowserTarget(hostKind, target.kind)) {
      void vscode.window.showInformationMessage(
        `RefHaven cannot build a reliable ${describeHostKind(hostKind)} link for this target, so it will not open one.`,
      );
      return null;
    }
    return buildBrowserUrl(project, target);
  }

  private async selectProject(repositoryRoot: string): Promise<BrowserProject | null> {
    const configured = readExtensionSetting<unknown>(
      EXTENSION_SETTINGS.approvedBrowserOrigins,
      EXTENSION_SETTING_DEFAULTS.approvedBrowserOrigins,
    );
    if (!Array.isArray(configured)) {
      throw new Error("RefHaven approved browser origins must be an array.");
    }
    const approvedOrigins = parseApprovedBrowserOrigins(configured);
    const remotes = await listGitRemoteUrls(repositoryRoot);
    const hasExplicitAllowlist = approvedOrigins.length > 0;
    const projects = applyHostGrammarOverride(
      resolveBrowserProjects(remotes, approvedOrigins),
      readExtensionSetting<unknown>(
        EXTENSION_SETTINGS.browserHostGrammar,
        EXTENSION_SETTING_DEFAULTS.browserHostGrammar,
      ),
    );
    if (projects.length === 0) {
      const action = await vscode.window.showInformationMessage(
        hasExplicitAllowlist
          ? "No repository remote matches the configured approved browser origins."
          : "No supported remote could provide a browser origin. Configure an exact origin for custom hosts or ports.",
        "Configure Origins",
      );
      if (action === "Configure Origins") await this.openApprovedOriginsSetting();
      return null;
    }
    if (projects.length === 1) return projects[0] ?? null;
    const selected = await vscode.window.showQuickPick(
      projects.map((project) => ({
        description: project.browserOrigin.origin,
        detail: `remote ${project.remoteName}`,
        label: project.projectPath,
        project,
      })),
      {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: "Select the approved project",
        title: "RefHaven: Open in Browser",
      },
    );
    return selected?.project ?? null;
  }

  private async openApprovedOriginsSetting(): Promise<void> {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      extensionSettingPath(EXTENSION_SETTINGS.approvedBrowserOrigins),
    );
  }

  private async resolveRepositoryRoot(candidate?: unknown): Promise<string | null> {
    const target = await resolveFileContextTarget(candidate);
    if (target) return target.repositoryRoot;
    const repositories = await discoverRepositories();
    if (repositories.length === 0) {
      throw new Error("No Git repository is available in this workspace.");
    }
    if (repositories.length === 1) return repositories[0]?.rootPath ?? null;
    const selected = await vscode.window.showQuickPick(
      repositories.map((repository) => ({
        description: repository.relativeRepositoryPath,
        label: repository.label,
        repository,
      })),
      {
        placeHolder: "Select a repository",
        title: "RefHaven: Select Repository",
      },
    );
    return selected?.repository.rootPath ?? null;
  }

  private async requireKnownRepository(candidate: unknown): Promise<string> {
    if (typeof candidate !== "string") throw new Error("The selected repository is invalid.");
    const [expected, repositories] = await Promise.all([
      canonicalPathIdentityKey(candidate),
      discoverRepositories(),
    ]);
    if (!expected) throw new Error("The selected repository is not available in this workspace.");
    const repository = repositories.find(({ rootPath }) => pathIdentityKey(rootPath) === expected);
    if (!repository) throw new Error("The selected repository is not available in this workspace.");
    return repository.rootPath;
  }
}

function selectedEditorLines(
  uri: vscode.Uri,
): { readonly endLine: number; readonly startLine: number } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || pathIdentityKey(editor.document.uri.fsPath) !== pathIdentityKey(uri.fsPath)) {
    return undefined;
  }
  const start = editor.selection.start;
  const end = editor.selection.end;
  const endLine =
    end.line > start.line && end.character === 0 ? end.line : Math.max(start.line, end.line) + 1;
  return {
    endLine,
    startLine: Math.min(start.line, end.line) + 1,
  };
}

function validatedLines(
  startLine: unknown,
  endLine: unknown,
): { readonly endLine?: number; readonly startLine?: number } {
  if (startLine === undefined && endLine === undefined) return {};
  if (
    !Number.isSafeInteger(startLine) ||
    (startLine as number) < 1 ||
    (endLine !== undefined &&
      (!Number.isSafeInteger(endLine) || (endLine as number) < (startLine as number)))
  ) {
    throw new Error("The selected line range is invalid.");
  }
  return {
    ...(endLine === undefined ? {} : { endLine: endLine as number }),
    startLine: startLine as number,
  };
}

function referenceKindLabel(ref: BranchRef): string {
  switch (ref.kind) {
    case "head":
      return "HEAD";
    case "localBranch":
      return "local branch";
    case "remoteBranch":
      return "remote-tracking branch";
    case "tag":
      return "tag";
    case "revision":
      return "revision";
    case "workingTree":
      return "working tree";
  }
}
