import * as vscode from "vscode";

/**
 * Refuses anything that is not a plain web address.
 *
 * `Uri.parse` accepts far more than HTTP: `file:`, `vscode:`, `command:` and
 * other handlers all parse successfully, and handing one to the operating
 * system does something quite different from opening a page. Callers validate
 * their own URLs against their own rules; this is the last check that applies
 * to all of them regardless.
 */
function isWebUrl(uri: vscode.Uri): boolean {
  return uri.scheme === "https" || uri.scheme === "http";
}

/**
 * Opens a web address in the user's browser.
 *
 * This is the only place in RefHaven that hands anything to the operating
 * system, so the extension's entire outbound surface is one function that can
 * be read in full. The data-egress guard keeps it that way: a call to
 * `openExternal` anywhere else fails the build.
 *
 * Returns whether the browser accepted the URL.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  const uri = vscode.Uri.parse(url, true);
  if (!isWebUrl(uri)) {
    throw new Error("RefHaven refused to open a URL that is not a web address.");
  }
  return vscode.env.openExternal(uri);
}
