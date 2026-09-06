/**
 * Structured logging (spec §12, §29).
 *
 * JSON-lines logger with levels and mandatory redaction. Logs never carry
 * credentials, and every log line is a single JSON object so downstream
 * collectors can parse without heuristics.
 */

import { redactDeep } from '../redaction/redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface JsonLoggerOptions {
  level?: LogLevel;
  redact?: boolean;
  /** Write target; defaults to process.stderr (keeps stdout clean for CLI output). */
  write?: (line: string) => void;
}

export class JsonLogger implements Logger {
  private readonly minLevel: number;
  private readonly redact: boolean;
  private readonly write: (line: string) => void;

  constructor(options: JsonLoggerOptions = {}) {
    this.minLevel = LEVEL_ORDER[options.level ?? 'info'];
    this.redact = options.redact ?? true;
    this.write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.log('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.log('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.log('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.log('error', message, fields);
  }

  private log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...(fields ? { fields: this.redact ? redactDeep(fields) : fields } : {}),
    });
    this.write(line);
  }
}

export class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
