import * as vscode from "vscode";

import type {
  CommitSearchKind,
  CommitSearchPatternMode,
  CommitSearchQuery,
} from "../domain/commitDetails";
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
  type CommitDetailsTreeProvider,
} from "../ui/tree/CommitDetailsTreeProvider";
import { formatRelativeTime } from "../ui/format";
import type { Logger } from "./Logger";
import { showTransientSuccess } from "../ui/feedback";
import type { ComparisonController } from "./ComparisonController";

interface SearchScopeItem extends vscode.QuickPickItem {
  readonly searchKind: CommitSearchKind;
}

interface SearchPatternItem extends vscode.QuickPickItem {
  readonly caseSensitive?: boolean;
  readonly patternMode: CommitSearchPatternMode;
}

export class CommitDetailsController {
  public constructor(
    private readonly treeProvider: CommitDetailsTreeProvider,
    private readonly comparisonController: ComparisonController,
    private readonly logger: Logger,
  ) {}

  public async show(repositoryRoot: string, commit: CommitInfo): Promise<void> {
    this.treeProvider.setCommit(repositoryRoot, commit);
    await vscode.commands.executeCommand(COMMIT_DETAILS_FOCUS_COMMAND);
    this.logger.info("Opened commit details", { operation: "showCommitDetails" });
  }

  public async copyDetail(node: DetailNode): Promise<void> {
    await vscode.env.clipboard.writeText(node.copyValue);
    showTransientSuccess(`${node.label} copied`);
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
    const scope = await vscode.window.showQuickPick<SearchScopeItem>(
      [
        { searchKind: "message", label: "$(comment) Commit message" },
        { searchKind: "author", label: "$(account) Author" },
        { searchKind: "sha", label: "$(git-commit) SHA" },
        { searchKind: "content", label: "$(search) Changed content" },
      ],
      { placeHolder: "Choose how to search local commits", title: "RefHaven: Search Commits" },
    );
    if (!scope) return;
    const pattern =
      scope.searchKind === "sha" ? undefined : await pickSearchPattern(scope.searchKind);
    if (scope.searchKind !== "sha" && !pattern) return;
    const query = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: searchPlaceholder(scope.searchKind, pattern),
      prompt:
        "Only objects already present in the local repository are searched; the query is never logged",
      title: `RefHaven: Search by ${scope.searchKind}`,
      validateInput: (value) => validateSearchInput(scope.searchKind, value),
    });
    if (!query) return;
    const searchQuery = createSearchQuery(scope.searchKind, query, pattern);
    const commits = await searchCommits(repository.rootPath, searchQuery);
    this.logger.info("Searched local commits", {
      caseSensitive:
        searchQuery.kind === "author" || searchQuery.kind === "message"
          ? searchQuery.caseSensitive
          : searchQuery.kind === "content"
            ? true
            : undefined,
      kind: searchQuery.kind,
      operation: "searchCommits",
      patternMode: searchQuery.kind === "sha" ? "sha" : searchQuery.patternMode,
      resultCount: commits.length,
    });
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

async function pickSearchPattern(
  kind: Exclude<CommitSearchKind, "sha">,
): Promise<SearchPatternItem | undefined> {
  if (kind === "content") {
    return vscode.window.showQuickPick<SearchPatternItem>(
      [
        {
          detail: "Match exact text in added or removed lines",
          label: "$(whole-word) Literal text",
          patternMode: "literal",
        },
        {
          detail: "Match a POSIX extended regular expression in added or removed lines",
          label: "$(regex) Regular expression",
          patternMode: "regex",
        },
      ],
      {
        placeHolder: "Choose how changed lines are matched (case-sensitive)",
        title: "RefHaven: Content Search Mode",
      },
    );
  }

  return vscode.window.showQuickPick<SearchPatternItem>(
    [
      {
        caseSensitive: false,
        detail: "Literal substring, ignoring letter case",
        label: "$(case-insensitive) Literal · Ignore case",
        patternMode: "literal",
      },
      {
        caseSensitive: true,
        detail: "Literal substring with exact letter case",
        label: "$(case-sensitive) Literal · Match case",
        patternMode: "literal",
      },
      {
        caseSensitive: false,
        detail: "POSIX extended regular expression, ignoring letter case",
        label: "$(regex) Regex · Ignore case",
        patternMode: "regex",
      },
      {
        caseSensitive: true,
        detail: "POSIX extended regular expression with exact letter case",
        label: "$(regex) Regex · Match case",
        patternMode: "regex",
      },
    ],
    { placeHolder: "Choose literal or regex matching", title: "RefHaven: Search Match Mode" },
  );
}

function createSearchQuery(
  kind: CommitSearchKind,
  text: string,
  pattern: SearchPatternItem | undefined,
): CommitSearchQuery {
  if (kind === "sha") return { kind, text };
  if (!pattern) throw new Error("The commit search match mode is missing.");
  if (kind === "content") return { kind, patternMode: pattern.patternMode, text };
  return {
    caseSensitive: pattern.caseSensitive ?? false,
    kind,
    patternMode: pattern.patternMode,
    text,
  };
}

function searchPlaceholder(kind: CommitSearchKind, pattern: SearchPatternItem | undefined): string {
  if (kind === "sha") return "Commit SHA prefix";
  if (kind === "author") return "Author name or email";
  const value = pattern?.patternMode === "regex" ? "POSIX regular expression" : "Literal text";
  if (kind === "content") return `${value} in added or removed lines`;
  return `${value} in the commit message`;
}

function validateSearchInput(kind: CommitSearchKind, value: string): string | undefined {
  if (value.length === 0) return "Enter a search value.";
  if (value.length > 512) return "Search is too long.";
  if (kind === "sha" && !/^[0-9a-f]{4,64}$/iu.test(value)) {
    return "Enter 4 to 64 hexadecimal characters.";
  }
  return undefined;
}
