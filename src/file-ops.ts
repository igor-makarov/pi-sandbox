import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import picomatch from "picomatch";

import type { SandboxConfig } from "./types";

export function expandHomePath(path: string): string {
  if (path.startsWith("~/")) {
    return homedir() + path.slice(1);
  }

  if (path === "~") {
    return homedir();
  }

  return path;
}

/**
 * Checks if reading from a path is allowed by sandbox config.
 */
export function isReadAllowed(path: string, cwd: string, config: SandboxConfig): boolean {
  const absolutePath = resolvePath(path, cwd);
  const denyRead = config.filesystem?.denyRead;

  if (!denyRead || denyRead.length === 0) {
    return true;
  }

  return !denyRead.some((pattern) => pathMatchesPattern(absolutePath, pattern, cwd));
}

/**
 * Checks if writing to a path is allowed by sandbox config.
 * Path must match at least one allowWrite pattern (if defined) and must not match any denyWrite pattern.
 */
export function isWriteAllowed(path: string, cwd: string, config: SandboxConfig): boolean {
  const absolutePath = resolvePath(path, cwd);
  const allowWrite = config.filesystem?.allowWrite;
  const denyWrite = config.filesystem?.denyWrite;

  // Check denyWrite first - if path matches any deny pattern, reject
  if (denyWrite && denyWrite.length > 0) {
    if (denyWrite.some((pattern) => pathMatchesPattern(absolutePath, pattern, cwd))) {
      return false;
    }
  }

  // Check allowWrite - if defined and non-empty, path must match at least one pattern
  if (allowWrite && allowWrite.length > 0) {
    return allowWrite.some((pattern) => pathMatchesPattern(absolutePath, pattern, cwd));
  }

  // No allowWrite restrictions defined, allow by default
  return true;
}

export function pathMatchesPattern(path: string, pattern: string, cwd: string): boolean {
  // Expand ~ in pattern
  pattern = expandHomePath(pattern);

  // Resolve relative patterns (., ./, relative paths) against cwd
  if (pattern === ".") {
    pattern = cwd;
  } else if (pattern.startsWith("./")) {
    pattern = cwd + pattern.slice(1);
  } else if (!pattern.startsWith("/") && pattern.includes("/")) {
    // Relative path with directory component (e.g., "src/foo")
    pattern = cwd + "/" + pattern;
  }

  // matchBase: patterns without / match against basename (e.g., *.pem matches /foo/bar.pem)
  // Check before adding {,/**} suffix which introduces /
  const useMatchBase = !pattern.includes("/");

  // For patterns without wildcards, also match children (e.g., /foo matches /foo/bar)
  if (!pattern.includes("*") && !pattern.includes("?")) {
    pattern = pattern + "{,/**}";
  }

  if (useMatchBase) {
    return picomatch.isMatch(path, pattern, { matchBase: true });
  } else {
    return picomatch.isMatch(path, pattern);
  }
}

function resolvePath(path: string, cwd: string): string {
  path = expandHomePath(path);

  if (!isAbsolute(path)) {
    path = resolve(cwd, path);
  }

  return path;
}
