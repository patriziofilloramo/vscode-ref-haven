export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogMetadataValue = string | number | boolean | null | undefined;

export type LogMetadata = Readonly<Record<string, LogMetadataValue>>;

export interface Logger {
  debug(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
}
