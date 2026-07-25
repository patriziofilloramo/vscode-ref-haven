import type * as vscode from "vscode";

import {
  COMPARISON_STORAGE_KEY,
  deduplicateComparisons,
  hasSameComparisonIdentity,
  sortComparisonsForDisplay,
  type ComparisonIdentity,
  type SavedComparisonV1,
} from "../domain/comparison";
import { isSavedComparisonV1 } from "../domain/validation";

type WorkspaceState = Pick<vscode.ExtensionContext["workspaceState"], "get" | "update">;

/**
 * Owns persistence of saved comparisons in workspace state. All reads return
 * validated, deduplicated comparisons in display order (pinned first).
 */
export class ComparisonStore {
  public constructor(private readonly workspaceState: WorkspaceState) {}

  public getAll(): SavedComparisonV1[] {
    const raw = this.workspaceState.get<unknown>(COMPARISON_STORAGE_KEY, []);
    if (!Array.isArray(raw)) return [];
    const valid = raw.filter(isSavedComparisonV1).sort((left, right) => left.order - right.order);
    return sortComparisonsForDisplay(deduplicateComparisons(valid));
  }

  public findByIdentity(identity: ComparisonIdentity): SavedComparisonV1 | undefined {
    return this.getAll().find((comparison) => hasSameComparisonIdentity(comparison, identity));
  }

  public nextOrder(): number {
    return (
      this.getAll().reduce((highest, comparison) => Math.max(highest, comparison.order), -1) + 1
    );
  }

  public async add(comparison: SavedComparisonV1): Promise<SavedComparisonV1[]> {
    return this.persist([...this.getAll(), comparison]);
  }

  public async remove(id: string): Promise<SavedComparisonV1[]> {
    return this.persist(this.getAll().filter((comparison) => comparison.id !== id));
  }

  public async replace(
    id: string,
    update: (comparison: SavedComparisonV1) => SavedComparisonV1,
  ): Promise<SavedComparisonV1[]> {
    return this.persist(
      this.getAll().map((comparison) => (comparison.id === id ? update(comparison) : comparison)),
    );
  }

  private async persist(comparisons: readonly SavedComparisonV1[]): Promise<SavedComparisonV1[]> {
    const normalized = sortComparisonsForDisplay(deduplicateComparisons(comparisons));
    await this.workspaceState.update(COMPARISON_STORAGE_KEY, normalized);
    return normalized;
  }
}
