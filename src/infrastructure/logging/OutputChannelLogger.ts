import type * as vscode from "vscode";

import type { Logger, LogLevel, LogMetadata, LogMetadataValue } from "../../application/Logger";

const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_METADATA_KEY =
  /author|authorization|branch|content|credential|email|environment|message|password|path|ref|remote|repository|secret|sha|subject|token/i;

type OutputChannel = Pick<vscode.OutputChannel, "appendLine" | "dispose">;

function sanitizeMetadata(metadata: LogMetadata): Readonly<Record<string, LogMetadataValue>> {
  return Object.fromEntries(
    Object.entries(metadata)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => [key, SENSITIVE_METADATA_KEY.test(key) ? REDACTED_VALUE : value]),
  );
}

export function formatLogEntry(
  level: LogLevel,
  message: string,
  metadata: LogMetadata = {},
  timestamp: Date = new Date(),
): string {
  const prefix = `${timestamp.toISOString()} ${level.toUpperCase()} ${message}`;
  const entries = Object.entries(metadata);

  if (entries.length === 0) {
    return prefix;
  }

  return `${prefix} ${JSON.stringify(sanitizeMetadata(metadata))}`;
}

export class OutputChannelLogger implements Logger, vscode.Disposable {
  public constructor(private readonly outputChannel: OutputChannel) {}

  public debug(message: string, metadata?: LogMetadata): void {
    this.write("debug", message, metadata);
  }

  public info(message: string, metadata?: LogMetadata): void {
    this.write("info", message, metadata);
  }

  public warn(message: string, metadata?: LogMetadata): void {
    this.write("warn", message, metadata);
  }

  public error(message: string, metadata?: LogMetadata): void {
    this.write("error", message, metadata);
  }

  public dispose(): void {
    this.outputChannel.dispose();
  }

  private write(level: LogLevel, message: string, metadata?: LogMetadata): void {
    this.outputChannel.appendLine(formatLogEntry(level, message, metadata));
  }
}
