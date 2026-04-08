import { homedir } from "node:os";
import { describe, expect, it } from "vitest";

import { expandHomePath, isReadAllowed, isWriteAllowed, pathMatchesPattern } from "./file-ops";
import type { SandboxConfig } from "./types";

describe("expandHomePath", () => {
  const home = homedir();

  it("expands ~/<path> to the home directory", () => {
    expect(expandHomePath("~/.ssh")).toBe(`${home}/.ssh`);
    expect(expandHomePath("~/Documents/file.txt")).toBe(`${home}/Documents/file.txt`);
  });

  it("expands standalone ~ to the home directory", () => {
    expect(expandHomePath("~")).toBe(home);
  });

  it("leaves non-home-prefixed paths unchanged", () => {
    expect(expandHomePath("/tmp/file.txt")).toBe("/tmp/file.txt");
    expect(expandHomePath("src/index.ts")).toBe("src/index.ts");
    expect(expandHomePath("~other/file.txt")).toBe("~other/file.txt");
  });
});

describe("pathMatchesPattern", () => {
  const home = homedir();
  const cwd = "/projects/myapp";

  describe("tilde expansion", () => {
    it("expands ~ in pattern to home directory", () => {
      expect(pathMatchesPattern(`${home}/.ssh`, "~/.ssh", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/.ssh/id_rsa`, "~/.ssh", cwd)).toBe(true);
    });

    it("expands standalone ~ in pattern", () => {
      expect(pathMatchesPattern(home, "~", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/Documents`, "~", cwd)).toBe(true);
    });
  });

  describe("directory matching", () => {
    it("matches exact directory path", () => {
      expect(pathMatchesPattern(`${home}/.ssh`, "~/.ssh", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/.aws`, "~/.aws", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/.gnupg`, "~/.gnupg", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/.claude`, "~/.claude", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/.pi`, "~/.pi", cwd)).toBe(true);
    });

    it("matches files inside directory", () => {
      expect(pathMatchesPattern(`${home}/.ssh/id_rsa`, "~/.ssh", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/.ssh/config`, "~/.ssh", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/.ssh/known_hosts`, "~/.ssh", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/.aws/credentials`, "~/.aws", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/.gnupg/secring.gpg`, "~/.gnupg", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/.claude/config.json`, "~/.claude", cwd)).toBe(true);
      expect(pathMatchesPattern(`${home}/.pi/settings.json`, "~/.pi", cwd)).toBe(true);
    });

    it("matches deeply nested files", () => {
      expect(pathMatchesPattern(`${home}/.ssh/keys/work/id_rsa`, "~/.ssh", cwd)).toBe(true);
    });

    it("does not match unrelated paths", () => {
      expect(pathMatchesPattern("/etc/hosts", "~/.ssh", cwd)).toBe(false);
      expect(pathMatchesPattern(`${home}/.bashrc`, "~/.ssh", cwd)).toBe(false);
      expect(pathMatchesPattern(`${home}/Documents/file.txt`, "~/.ssh", cwd)).toBe(false);
    });

    it("does not match paths that merely start with pattern", () => {
      expect(pathMatchesPattern(`${home}/.ssh-backup`, "~/.ssh", cwd)).toBe(false);
    });
  });

  describe("absolute path matching", () => {
    it("matches absolute path patterns", () => {
      expect(pathMatchesPattern("/projects/myapp/secrets/api.key", "/projects/myapp/secrets", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/myapp/secrets", "/projects/myapp/secrets", cwd)).toBe(true);
    });

    it("does not match paths outside pattern", () => {
      expect(pathMatchesPattern("/projects/myapp/src/index.ts", "/projects/myapp/secrets", cwd)).toBe(false);
    });
  });

  describe("glob patterns", () => {
    it("matches wildcard extension patterns", () => {
      expect(pathMatchesPattern("/projects/server.pem", "*.pem", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/private.key", "*.key", cwd)).toBe(true);
    });

    it("matches dotfile wildcard patterns", () => {
      expect(pathMatchesPattern("/projects/.env.local", ".env.*", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/.env.production", ".env.*", cwd)).toBe(true);
    });

    it("matches exact basename patterns", () => {
      expect(pathMatchesPattern("/projects/.env", ".env", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/.claude", ".claude", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/.pi", ".pi", cwd)).toBe(true);
    });

    it("matches nested files with basename patterns", () => {
      expect(pathMatchesPattern("/projects/certs/server.pem", "*.pem", cwd)).toBe(true);
      expect(pathMatchesPattern("/absolute/path/to/private.key", "*.key", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/config/.env", ".env", cwd)).toBe(true);
      expect(pathMatchesPattern("/some/path/.claude", ".claude", cwd)).toBe(true);
    });

    it("does not match files with different extensions", () => {
      expect(pathMatchesPattern("/projects/server.cert", "*.pem", cwd)).toBe(false);
      expect(pathMatchesPattern("/projects/config.json", "*.key", cwd)).toBe(false);
    });

    it("does not match similar but different basenames", () => {
      expect(pathMatchesPattern("/projects/.envrc", ".env", cwd)).toBe(false);
      expect(pathMatchesPattern("/projects/.envrc", ".env.*", cwd)).toBe(false);
    });
  });

  describe("relative pattern matching", () => {
    it("resolves . pattern to cwd", () => {
      expect(pathMatchesPattern("/projects/myapp", ".", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/myapp/src/index.ts", ".", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/myapp/memory/.dreams/run.txt", ".", cwd)).toBe(true);
      expect(pathMatchesPattern("/other/path", ".", cwd)).toBe(false);
    });

    it("resolves ./ patterns relative to cwd", () => {
      expect(pathMatchesPattern("/projects/myapp/src/index.ts", "./src", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/myapp/src", "./src", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/myapp/other/file.ts", "./src", cwd)).toBe(false);
    });

    it("resolves relative glob patterns against cwd", () => {
      expect(pathMatchesPattern("/projects/myapp/foo/test.bar", "foo/*.bar", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/myapp/foo/x.bar", "foo/*.bar", cwd)).toBe(true);
      expect(pathMatchesPattern("/projects/myapp/foo/test.baz", "foo/*.bar", cwd)).toBe(false);
      expect(pathMatchesPattern("/other/foo/test.bar", "foo/*.bar", cwd)).toBe(false);
    });
  });
});

describe("isReadAllowed", () => {
  const cwd = "/projects/myapp";
  const home = homedir();

  function createConfig(denyRead: string[]): SandboxConfig {
    return { filesystem: { denyRead } } as SandboxConfig;
  }

  describe("empty or missing config", () => {
    it("allows any path when denyRead is empty", () => {
      expect(isReadAllowed("/any/path", cwd, createConfig([]))).toBe(true);
      expect(isReadAllowed("~/.ssh/id_rsa", cwd, createConfig([]))).toBe(true);
    });

    it("allows any path when config is empty", () => {
      expect(isReadAllowed("/any/path", cwd, {} as SandboxConfig)).toBe(true);
    });
  });

  describe("path resolution", () => {
    const deny = createConfig(["/projects/myapp/secrets", "~/.ssh"]);

    it("resolves relative paths against cwd", () => {
      expect(isReadAllowed("secrets/api.key", cwd, deny)).toBe(false);
      expect(isReadAllowed("./secrets/api.key", cwd, deny)).toBe(false);
      expect(isReadAllowed("src/index.ts", cwd, deny)).toBe(true);
    });

    it("expands ~ in input path", () => {
      expect(isReadAllowed("~/.ssh/id_rsa", cwd, deny)).toBe(false);
      expect(isReadAllowed("~/.bashrc", cwd, deny)).toBe(true);
    });

    it("handles absolute paths directly", () => {
      expect(isReadAllowed("/projects/myapp/secrets/key", cwd, deny)).toBe(false);
      expect(isReadAllowed(`${home}/.ssh/config`, cwd, deny)).toBe(false);
    });
  });

  describe("multiple deny patterns", () => {
    const deny = createConfig(["~/.ssh", "~/.aws", "*.pem"]);

    it("denies if any pattern matches", () => {
      expect(isReadAllowed(`${home}/.ssh/id_rsa`, cwd, deny)).toBe(false);
      expect(isReadAllowed(`${home}/.aws/credentials`, cwd, deny)).toBe(false);
      expect(isReadAllowed("/projects/cert.pem", cwd, deny)).toBe(false);
    });

    it("allows only if no patterns match", () => {
      expect(isReadAllowed("/etc/hosts", cwd, deny)).toBe(true);
      expect(isReadAllowed(`${home}/.bashrc`, cwd, deny)).toBe(true);
    });
  });
});

describe("isWriteAllowed", () => {
  const cwd = "/projects/myapp";
  const home = homedir();

  function createConfig(allowWrite?: string[], denyWrite?: string[]): SandboxConfig {
    return { filesystem: { allowWrite, denyWrite } } as SandboxConfig;
  }

  describe("empty or missing config", () => {
    it("allows any path when both allowWrite and denyWrite are empty", () => {
      expect(isWriteAllowed("/any/path", cwd, createConfig([], []))).toBe(true);
      expect(isWriteAllowed("~/.ssh/id_rsa", cwd, createConfig([], []))).toBe(true);
    });

    it("allows any path when config is empty", () => {
      expect(isWriteAllowed("/any/path", cwd, {} as SandboxConfig)).toBe(true);
    });
  });

  describe("allowWrite restrictions", () => {
    const config = createConfig([".", "/tmp"], []);

    it("allows paths within cwd", () => {
      expect(isWriteAllowed("src/index.ts", cwd, config)).toBe(true);
      expect(isWriteAllowed("./src/index.ts", cwd, config)).toBe(true);
      expect(isWriteAllowed("/projects/myapp/src/index.ts", cwd, config)).toBe(true);
      expect(isWriteAllowed("/projects/myapp/memory/.dreams/run.txt", cwd, config)).toBe(true);
    });

    it("allows paths within /tmp", () => {
      expect(isWriteAllowed("/tmp/test.txt", cwd, config)).toBe(true);
      expect(isWriteAllowed("/tmp/subdir/file.txt", cwd, config)).toBe(true);
    });

    it("denies paths outside allowed areas", () => {
      expect(isWriteAllowed("/etc/hosts", cwd, config)).toBe(false);
      expect(isWriteAllowed(`${home}/.bashrc`, cwd, config)).toBe(false);
      expect(isWriteAllowed("/other/project/file.ts", cwd, config)).toBe(false);
    });
  });

  describe("denyWrite restrictions", () => {
    const config = createConfig([], [".env", ".env.*", "*.pem", "*.key"]);

    it("denies .env files", () => {
      expect(isWriteAllowed(".env", cwd, config)).toBe(false);
      expect(isWriteAllowed("/projects/myapp/.env", cwd, config)).toBe(false);
    });

    it("denies .env.* files", () => {
      expect(isWriteAllowed(".env.local", cwd, config)).toBe(false);
      expect(isWriteAllowed(".env.production", cwd, config)).toBe(false);
      expect(isWriteAllowed("/projects/myapp/.env.test", cwd, config)).toBe(false);
    });

    it("denies .pem and .key files", () => {
      expect(isWriteAllowed("server.pem", cwd, config)).toBe(false);
      expect(isWriteAllowed("private.key", cwd, config)).toBe(false);
      expect(isWriteAllowed("/certs/server.pem", cwd, config)).toBe(false);
    });

    it("allows other files", () => {
      expect(isWriteAllowed("src/index.ts", cwd, config)).toBe(true);
      expect(isWriteAllowed("config.json", cwd, config)).toBe(true);
    });
  });

  describe("combined allowWrite and denyWrite", () => {
    const config = createConfig([".", "/tmp"], [".env", ".env.*", "*.pem"]);

    it("denies paths matching denyWrite even if in allowWrite area", () => {
      expect(isWriteAllowed(".env", cwd, config)).toBe(false);
      expect(isWriteAllowed("/projects/myapp/.env.local", cwd, config)).toBe(false);
      expect(isWriteAllowed("certs/server.pem", cwd, config)).toBe(false);
    });

    it("allows paths in allowWrite that don't match denyWrite", () => {
      expect(isWriteAllowed("src/index.ts", cwd, config)).toBe(true);
      expect(isWriteAllowed("/tmp/test.txt", cwd, config)).toBe(true);
    });

    it("denies paths outside allowWrite even if not in denyWrite", () => {
      expect(isWriteAllowed("/etc/hosts", cwd, config)).toBe(false);
      expect(isWriteAllowed(`${home}/.bashrc`, cwd, config)).toBe(false);
    });
  });

  describe("path resolution", () => {
    const config = createConfig(["."], [".env"]);

    it("resolves relative paths against cwd", () => {
      expect(isWriteAllowed("src/file.ts", cwd, config)).toBe(true);
      expect(isWriteAllowed("./src/file.ts", cwd, config)).toBe(true);
    });

    it("expands ~ in input path", () => {
      expect(isWriteAllowed(`${home}/.bashrc`, cwd, config)).toBe(false); // outside allowWrite
    });
  });
});
