import { assertRepositoryWorktreeGitPath } from "../../domain/pathValidation";
import { assertInactiveContentFilterOutput } from "./contentFilterAttributes";
import { runGitWithInput } from "./GitProcess";

export { UnsupportedContentFilterError } from "./contentFilterAttributes";

/** Fails closed without invoking clean, smudge, process, or textconv drivers. */
export async function assertNoActiveContentFilters(
  repositoryRoot: string,
  filePaths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const paths = [...new Set(filePaths)];
  if (paths.length === 0) return;
  for (const filePath of paths) assertRepositoryWorktreeGitPath(filePath);

  const output = await runGitWithInput(
    repositoryRoot,
    ["check-attr", "--stdin", "-z", "filter"],
    `${paths.join("\0")}\0`,
    signal,
  );
  assertInactiveContentFilterOutput(output, paths);
}
