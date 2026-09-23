/**
 * Structured logging. Two rules that matter more than the implementation:
 *  1. Every pipeline log carries workspace_id / upload_id / analysis_run_id (13.2).
 *  2. BYOK keys and PAT plaintext never reach a log line (8.4). `redactLogValue`
 *     is the last-ditch net; the real defence is not passing them in.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  workspace_id?: string;
  upload_id?: string;
  analysis_run_id?: string;
  agent_id?: string;
  [k: string]: unknown;
}

const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/g,
];

export function redactLogValue(v: unknown): unknown {
  if (typeof v === 'string') {
    return SECRET_SHAPES.reduce((s, re) => s.replace(re, '[secret-redacted]'), v);
  }
  if (Array.isArray(v)) return v.map(redactLogValue);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) =>
        /token|secret|key|password|authorization/i.test(k)
          ? [k, '[secret-redacted]']
          : [k, redactLogValue(val)],
      ),
    );
  }
  return v;
}

/**
 * Where log lines go. 'stdout' is the default and right for a CLI or a
 * worker. An MCP server over stdio owns stdout for the protocol, so one
 * stray info line there is a malformed JSON-RPC frame and a dead session;
 * `actario mcp` calls setLogSink('stderr') before anything else runs.
 */
let sink: 'stdout' | 'stderr' = 'stdout';
export function setLogSink(next: 'stdout' | 'stderr'): void { sink = next; }

function emit(level: LogLevel, msg: string, ctx?: LogContext) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    msg,
    ...(ctx ? (redactLogValue(ctx) as object) : {}),
  });
  if (sink === 'stderr' || level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(base: LogContext): Logger;
}

export function createLogger(base: LogContext = {}): Logger {
  const at = (level: LogLevel) => (msg: string, ctx?: LogContext) =>
    emit(level, msg, { ...base, ...ctx });
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (more) => createLogger({ ...base, ...more }),
  };
}

export const logger = createLogger();
