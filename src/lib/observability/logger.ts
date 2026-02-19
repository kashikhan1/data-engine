export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
  child: (defaults: LogContext) => Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(level?: string): LogLevel {
  const raw = String(level || "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function canLog(target: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_ORDER[target] >= LEVEL_ORDER[threshold];
}

function serialize(message: string, context?: LogContext): string {
  if (!context || Object.keys(context).length === 0) return message;
  return `${message} ${JSON.stringify(context)}`;
}

export function createLogger(scope: string, defaults?: LogContext): Logger {
  const threshold = normalizeLevel(process.env.LOG_LEVEL);

  const logAt = (level: LogLevel, message: string, context?: LogContext) => {
    if (!canLog(level, threshold)) return;
    const payload: LogContext = {
      scope,
      ...defaults,
      ...(context || {}),
    };
    const line = serialize(message, payload);
    if (level === "debug") console.debug(line);
    else if (level === "info") console.info(line);
    else if (level === "warn") console.warn(line);
    else console.error(line);
  };

  return {
    debug: (message, context) => logAt("debug", message, context),
    info: (message, context) => logAt("info", message, context),
    warn: (message, context) => logAt("warn", message, context),
    error: (message, context) => logAt("error", message, context),
    child: (childDefaults) => createLogger(scope, { ...(defaults || {}), ...(childDefaults || {}) }),
  };
}
