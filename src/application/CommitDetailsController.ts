import * as vscode from "vscode";

import type { CommitSearchKind } from "../domain/commitDetails";
import type { CommitInfo } from "../domain/comparisonResult";
import {
  discoverRepositories,
  listChangedFiles,
  readCommitDetails,
  searchCommits,
} from "../infrastructure/git/GitCli";
import { pickRepository } from "../ui/pickers/comparisonPickers";
import {
  COMMIT_DETAILS_FOCUS_COMMAND,
  type DetailNode,
  type CommitDetailsTreeNode,
  type CommitDetailsTreeProvider,
} from "../ui/tree/CommitDetailsTreeProvider";
import { formatRelativeTime } from "../ui/format";
import type { Logger } from "./Logger";
import type { ComparisonController } from "./ComparisonController";

interface SearchModeItem extends vscode.QuickPickItem {
  readonly searchKind: CommitSearchKind;
}

export class CommitDetailsController {
  public constructor(
    private readonly treeProvider: CommitDetailsTreeProvider,
    private readonly treeView: vscode.TreeView<CommitDetailsTreeNode>,
    private readonly comparisonController: ComparisonController,
    private readonly logger: Logger,
  ) {}

  public async show(repositoryRoot: string, commit: CommitInfo): Promise<void> {
    this.treeProvider.setCommit(repositoryRoot, commit);
    this.treeView.description = commit.sha.slice(0, 8);
    await vscode.commands.executeCommand(COMMIT_DETAILS_FOCUS_COMMAND);
    this.logger.info("Opened commit details", { operation: "showCommitDetails" });
  }

  public async copyDetail(node: DetailNode): Promise<void> {
    await vscode.env.clipboard.writeText(node.copyValue);
    void vscode.window.showInformationMessage(`${node.label} copied to the clipboard.`);
  }

  public async openParent(node: DetailNode): Promise<void> {
    if (!node.parentSha) throw new Error("Select a parent commit first.");
    const details = await readCommitDetails(node.repositoryRoot, node.parentSha);
    await this.show(node.repositoryRoot, details.commit);
  }

  public async compareWithParent(node: DetailNode): Promise<void> {
    if (!node.parentSha) throw new Error("Select a parent commit first.");
    const files = await listChangedFiles(node.repositoryRoot, node.parentSha, node.commitSha);
    if (files.length === 0) {
      void vscode.window.showInformationMessage(
        "This commit has no changes relative to the parent.",
      );
      return;
    }
    const selected = await vscode.window.showQuickPick(
      files.map((file) => ({
        description: file.status,
        file,
        label: file.newPath,
      })),
      {
        placeHolder: "Select a changed file to compare with the parent",
        title: "RefHaven: Compare Commit with Parent",
      },
    );
    if (!selected) return;
    await this.comparisonController.openFileDiff(
      {
        fromSha: node.parentSha,
        label: `${node.commitSha.slice(0, 8)} relative to ${node.parentSha.slice(0, 8)}`,
        repositoryRootPath: node.repositoryRoot,
        toSha: node.commitSha,
      },
      selected.file,
    );
  }

  public async search(): Promise<void> {
    const repository = await pickRepository(await discoverRepositories());
    if (!repository) return;
    const mode = await vscode.window.showQuickPick<SearchModeItem>(
      [
        { searchKind: "message", label: "$(comment) Commit message" },
        { searchKind: "author", label: "$(account) Author" },
        { searchKind: "sha", label: "$(git-commit) SHA" },
        { searchKind: "content", label: "$(search) Changed content" },
      ],
      { placeHolder: "Choose how to search local commits", title: "RefHaven: Search Commits" },
    );
    if (!mode) return;
    const query = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: searchPlaceholder(mode.searchKind),
      prompt: "Only objects already present in the local repository are searched",
      title: `RefHaven: Search by ${mode.searchKind}`,
      validateInput: (value) =>
        value.length === 0
          ? "Enter a search value."
          : value.length > 512
            ? "Search is too long."
            : undefined,
    });
    if (!query) return;
    const commits = await searchCommits(repository.rootPath, mode.searchKind, query);
    if (commits.length === 0) {
      void vscode.window.showInformationMessage("No matching local commits were found.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      commits.map((commit) => ({
        commit,
        description: `${commit.authorName} · ${formatRelativeTime(commit.authorDate)}`,
        detail: commit.sha,
        label: `$(git-commit) ${commit.subject || "(no commit message)"}`,
      })),
      {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: "Select a commit",
        title: "RefHaven: Search Results",
      },
    );
    if (selected) await this.show(repository.rootPath, selected.commit);
  }
}

function searchPlaceholder(kind: CommitSearchKind): string {
  if (kind === "sha") return "Commit SHA prefix";
  if (kind === "author") return "Author name or email";
  if (kind === "content") return "Text added or removed by a commit";
  return "Text in the commit message";
}
