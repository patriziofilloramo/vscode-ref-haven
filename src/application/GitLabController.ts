import * as vscode from "vscode";

import type { BranchRef, SavedComparisonV1 } from "../domain/comparison";
import type { CommitInfo } from "../domain/comparisonResult";
import {
  buildApprovedGitLabUrl,
  matchApprovedGitLabProjects,
  parseApprovedGitLabOrigins,
  type GitLabProject,
  type GitLabTarget,
} from "../domain/gitLab";
import { pathIdentityKey } from "../domain/pathValidation";
import {
  discoverRepositories,
  fileExistsAtRevision,
  listComparisonRefs,
  listGitRemoteUrls,
  resolveRef,
} from "../infrastructure/git/GitCli";
import { resolveFileContextTarget, resolveKnownFileTarget } from "../ui/commands/fileContext";
import type { Logger } from "./Logger";

const CONFIG_SECTION = "refhaven";
const APPROVED_ORIGINS_SETTING = "gitLab.approvedOrigins";

export class GitLabController {
  public constructor(private readonly logger: Logger) {}

  public async openProject(candidate?: unknown): Promise<void> {
    const repositoryRoot = await this.resolveRepositoryRoot(candidate);
    if (!repositoryRoot) return;
    await this.open(repositoryRoot, { kind: "project" }, "openGitLabProject");
  }

  public async openCommit(repositoryRoot: unknown, commit: CommitInfo): Promise<void> {
    const root = await this.requireKnownRepository(repositoryRoot);
    const sha = await resolveRef(root, commit.sha);
    await this.open(root, { kind: "commit", sha }, "openGitLabCommit");
  }

  public async openBranch(repositoryRoot: unknown, branch: BranchRef): Promise<void> {
    const root = await this.requireKnownRepository(repositoryRoot);
    const sha = await resolveRef(root, branch.fullName);
    await this.open(root, { kind: "tree", sha }, "openGitLabBranch");
  }

  public async openComparison(comparison: SavedComparisonV1): Promise<void> {
    const repositoryRoot = await this.requireKnownRepository(comparison.repository.rootPath);
    if (comparison.targetRef.kind === "workingTree") {
      void vscode.window.showInformationMessage(
        "Working Tree comparisons do not have an immutable GitLab revision.",
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
      "openGitLabComparison",
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
        title: "RefHaven: Open Local Reference on GitLab",
      },
    );
    if (!selected) return;
    const sha = await resolveRef(repositoryRoot, selected.ref.fullName);
    await this.open(repositoryRoot, { kind: "tree", sha }, "openGitLabLocalReference");
  }

  public async openFile(candidate?: unknown): Promise<void> {
    const target = await resolveFileContextTarget(candidate);
    if (!target) throw new Error("Select a file inside a Git repository first.");
    const sha = await resolveRef(target.repositoryRoot, "HEAD");
    if (!(await fileExistsAtRevision(target.repositoryRoot, sha, target.filePath))) {
      void vscode.window.showInformationMessage(
        "This file is not available in HEAD and cannot be opened on GitLab yet.",
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
      "openGitLabFile",
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
    if (typeof sha !== "string") throw new Error("The selected GitLab revision is invalid.");
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
      "openGitLabFile",
    );
  }

  public async openReference(candidate?: unknown): Promise<void> {
    const repositoryRoot = await this.resolveRepositoryRoot(candidate);
    if (!repositoryRoot) return;
    const value = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "#123 or !123",
      prompt: "Enter a GitLab issue or merge request reference.",
      title: "RefHaven: Open GitLab Reference",
      validateInput: (input) =>
        /^[#!][1-9]\d*$/u.test(input.trim())
          ? undefined
          : "Use #123 for an issue or !123 for an MR.",
    });
    if (value === undefined) return;
    const reference = /^([#!])([1-9]\d*)$/u.exec(value.trim());
    const number = Number.parseInt(reference?.[2] ?? "", 10);
    if (!reference || !Number.isSafeInteger(number)) {
      throw new Error("The GitLab reference is invalid.");
    }
    await this.open(
      repositoryRoot,
      reference[1] === "#" ? { kind: "issue", number } : { kind: "mergeRequest", number },
      "openGitLabReference",
    );
  }

  private async open(
    repositoryRoot: string,
    target: GitLabTarget,
    operation: string,
  ): Promise<void> {
    const project = await this.selectProject(repositoryRoot);
    if (!project) return;
    const url = buildApprovedGitLabUrl(project, target);
    const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
    if (!opened) throw new Error("VS Code could not open the approved GitLab URL.");
    this.logger.info("Opened approved GitLab URL", { operation });
  }

  private async selectProject(repositoryRoot: string): Promise<GitLabProject | null> {
    const configured = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<unknown>(APPROVED_ORIGINS_SETTING, []);
    if (!Array.isArray(configured)) {
      throw new Error("RefHaven GitLab approved origins must be an array.");
    }
    const approvedOrigins = parseApprovedGitLabOrigins(configured);
    if (approvedOrigins.length === 0) {
      const action = await vscode.window.showWarningMessage(
        "Configure at least one exact GitLab HTTP(S) origin before opening repository links.",
        "Open Settings",
      );
      if (action === "Open Settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          `refhaven.${APPROVED_ORIGINS_SETTING}`,
        );
      }
      return null;
    }

    const projects = matchApprovedGitLabProjects(
      await listGitRemoteUrls(repositoryRoot),
      approvedOrigins,
    );
    if (projects.length === 0) {
      void vscode.window.showInformationMessage(
        "No repository remote matches the configured approved GitLab origins.",
      );
      return null;
    }
    if (projects.length === 1) return projects[0] ?? null;
    const selected = await vscode.window.showQuickPick(
      projects.map((project) => ({
        description: project.approvedOrigin.origin,
        detail: `remote ${project.remoteName}`,
        label: project.projectPath,
        project,
      })),
      {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: "Select the approved GitLab project",
        title: "RefHaven: Open on GitLab",
      },
    );
    return selected?.project ?? null;
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
        title: "RefHaven: GitLab Repository",
      },
    );
    return selected?.repository.rootPath ?? null;
  }

  private async requireKnownRepository(candidate: unknown): Promise<string> {
    if (typeof candidate !== "string") throw new Error("The selected repository is invalid.");
    const expected = pathIdentityKey(candidate);
    const repository = (await discoverRepositories()).find(
      ({ rootPath }) => pathIdentityKey(rootPath) === expected,
    );
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
    throw new Error("The selected GitLab line range is invalid.");
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
