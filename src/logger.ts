/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import { inspect } from "util";

import { Disposable, window } from "vscode";

export enum LogLevel {
    none = 0,
    error = 1,
    warn = 2,
    debug = 3,
}

export interface ILogger {
    debug(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
}

function getTimestamp(): string {
    return new Date().toISOString();
}

export class Logger implements Disposable {
    private disposables: Disposable[] = [];
    private fd = 0;
    private loggers: Map<string, ILogger> = new Map();
    private level!: LogLevel;
    private outputToConsole!: boolean;

    public init(level: LogLevel, filePath: string, outputToConsole = false) {
        this.level = level;
        this.outputToConsole = outputToConsole;
        if (filePath && level !== LogLevel.none) {
            try {
                this.fd = fs.openSync(filePath, "w");
            } catch {
                // ignore
            }
        }
        // this.channel = window.createOutputChannel(EXT_NAME);
        // this.disposables.push(this.channel);
    }

    public dispose(): void {
        if (this.fd) {
            fs.closeSync(this.fd);
        }
        this.disposables.forEach((d) => d.dispose());
    }

    private log(level: LogLevel, scope: string, args: any[]): void {
        const msg = args.reduce((p, c, i) => {
            if (typeof c === "object") {
                try {
                    c = inspect(c, false, 2, false);
                } catch {
                    // ignore
                }
            }
            return p + (i > 0 ? " " : "") + c;
        }, "");

        if (this.fd) {
            fs.appendFileSync(this.fd, msg + "\n");
        }
        if (this.outputToConsole) {
            console[level == LogLevel.error ? "error" : "log"](`${getTimestamp()} ${scope}: ${msg}`);
        }
        if (level === LogLevel.error) {
            window.showErrorMessage(msg);
        }
    }

    public createLogger(scope: string): ILogger {
        const logger = this.loggers.has(scope)
            ? this.loggers.get(scope)!
            : {
                  debug: (...args: any[]) => {
                      if (this.level >= LogLevel.debug) {
                          this.log(LogLevel.debug, scope, args);
                      }
                  },
                  warn: (...args: any[]) => {
                      if (this.level >= LogLevel.warn) {
                          this.log(LogLevel.warn, scope, args);
                      }
                  },
                  error: (...args: any[]) => {
                      if (this.level >= LogLevel.error) {
                          this.log(LogLevel.error, scope, args);
                      }
                  },
              };
        this.loggers.set(scope, logger);
        return logger;
    }
}

export const logger = new Logger();

export function createLogger(scope = "Neovim"): ILogger {
    return logger.createLogger(scope);
}
