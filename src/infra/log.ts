/**
 * stderr-only logger. stdout is the MCP JSON-RPC channel and must never
 * receive log output. Secrets are redacted before writing.
 */

type Level = 'error' | 'info' | 'debug';
const LEVELS: Record<Level, number> = { error: 0, info: 1, debug: 2 };

function currentLevel(): number {
  const env = (process.env.LINEUPIFY_LOG ?? 'info').toLowerCase() as Level;
  return LEVELS[env] ?? LEVELS.info;
}

const SECRET_PATTERNS: RegExp[] = [
  /(access_token"?\s*[:=]\s*"?)[A-Za-z0-9_-]{8,}/gi,
  /(refresh_token"?\s*[:=]\s*"?)[A-Za-z0-9_-]{8,}/gi,
  /(code=)[A-Za-z0-9_-]{8,}/gi,
  /(Bearer\s+)[A-Za-z0-9_-]{8,}/gi,
  /(api_key=)[A-Za-z0-9]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '$1<redacted>');
  return out;
}

function write(level: Level, msg: string, data?: unknown): void {
  if (LEVELS[level] > currentLevel()) return;
  const ts = new Date().toISOString();
  let line = `${ts} [lineupify:${level}] ${msg}`;
  if (data !== undefined) {
    let extra: string;
    try {
      extra = typeof data === 'string' ? data : JSON.stringify(data);
    } catch {
      extra = String(data);
    }
    line += ` ${extra}`;
  }
  process.stderr.write(redact(line) + '\n');
}

export const log = {
  error: (msg: string, data?: unknown) => write('error', msg, data),
  info: (msg: string, data?: unknown) => write('info', msg, data),
  debug: (msg: string, data?: unknown) => write('debug', msg, data),
};
