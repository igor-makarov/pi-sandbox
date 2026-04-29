import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { parse } from "shell-quote";

import type { SandboxState } from "./data/SandboxState";

export function createSandboxedBashOps(state: SandboxState): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      // Write command to a temp script file to avoid shell-quote escaping issues
      // in SandboxManager.wrapWithSandbox (e.g. '!' gets escaped to '\!')
      if (!state.sessionId) {
        throw new Error("sessionId not set — session_start must fire before sandbox exec");
      }
      const tmpDir = "/tmp/pi/sandbox-cmds";
      mkdirSync(tmpDir, { recursive: true });
      const hash = createHash("sha256").update(command).digest("hex").slice(0, 16);
      const tmpFile = `${tmpDir}/cmd-${state.sessionId}-${hash}.sh`;
      writeFileSync(tmpFile, command, { mode: 0o700 });

      const wrappedCommand = await SandboxManager.wrapWithSandbox(tmpFile);

      return new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", wrappedCommand], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        const onAbort = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        const cleanup = () => {
          try {
            unlinkSync(tmpFile);
          } catch {
            // ignore cleanup errors
          }
        };

        child.on("close", (code) => {
          cleanup();
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            // Annotate stderr with sandbox violations if command failed
            if (code !== 0) {
              const stderrOutput = "";
              const annotated = SandboxManager.annotateStderrWithSandboxFailures(command, stderrOutput);
              onData(Buffer.from(annotated));
            }

            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

/**
 * Checks if a command matches any of the unsandboxed command patterns.
 * Uses shell-quote to properly parse commands, handling quotes and escapes.
 *
 * - Exact match: "npm test" matches only "npm test"
 * - Prefix match: "npm run *" matches "npm run build", "npm run test", etc.
 * - Compound commands (with &&, ||, |, ;, redirects) are never matched for safety.
 * - Safe trailing redirects (2>&1, 2>/dev/null, etc.) are stripped before matching.
 */
export function isUnsandboxedCommand(command: string, unsandboxedCommands: string[]): boolean {
  const commandTokens = parseCommand(command);
  if ("isCompound" in commandTokens) {
    return false;
  }

  for (const pattern of unsandboxedCommands) {
    const { tokens: patternTokens, isPrefixMatch } = parsePattern(pattern);

    if (isPrefixMatch) {
      // Prefix match: command must have at least as many tokens as pattern (minus the *)
      if (patternTokens.length > commandTokens.length) continue;
      const matches = patternTokens.every((token, i) => token === commandTokens[i]);
      if (matches) return true;
    } else {
      // Exact match: command must have exactly the same tokens
      if (patternTokens.length !== commandTokens.length) continue;
      const matches = patternTokens.every((token, i) => token === commandTokens[i]);
      if (matches) return true;
    }
  }

  return false;
}

/**
 * Parses a command string into tokens. Globs are converted to their pattern strings.
 * Returns { isCompound: true } if the command contains shell operators (&&, ||, |, ;, redirects, etc.)
 * Safe trailing redirects (2>&1, 2>/dev/null, etc.) are stripped before parsing.
 */
function parseCommand(command: string): string[] | { isCompound: true } {
  const stripped = stripSafeTrailingRedirects(command);
  const parsed = parse(stripped.trim());
  const tokens: string[] = [];
  for (const token of parsed) {
    if (typeof token === "string") {
      tokens.push(token);
    } else if ("op" in token && token.op === "glob") {
      tokens.push(token.pattern);
    } else {
      return { isCompound: true };
    }
  }
  return tokens;
}

/**
 * Safe trailing redirects that are allowed at the end of commands.
 * These are harmless redirects that don't write to arbitrary files.
 * Order matters: more specific patterns must come first to avoid partial matches.
 */
const SAFE_TRAILING_REDIRECTS = [
  ">/dev/null 2>&1", // discard all output (POSIX)
  "&>/dev/null", // discard all output (bash shorthand)
  "2>/dev/null", // discard stderr
  "2>&1", // combine stderr into stdout
];

/**
 * Strips safe trailing redirects from a command string.
 * Returns the command without the redirect suffix.
 */
function stripSafeTrailingRedirects(command: string): string {
  let stripped = command.trimEnd();
  for (const redirect of SAFE_TRAILING_REDIRECTS) {
    if (stripped.endsWith(redirect)) {
      stripped = stripped.slice(0, -redirect.length).trimEnd();
      break; // Only strip one redirect
    }
  }
  return stripped;
}

/**
 * Parses a pattern string into tokens and determines if it's a prefix match (ends with *).
 */
function parsePattern(pattern: string): { tokens: string[]; isPrefixMatch: boolean } {
  const parsed = parse(pattern.trim());
  const tokens = parsed.filter((t): t is string => typeof t === "string");
  const lastToken = parsed[parsed.length - 1];
  const isPrefixMatch = typeof lastToken === "object" && "op" in lastToken && lastToken.op === "glob" && lastToken.pattern === "*";
  return { tokens, isPrefixMatch };
}
