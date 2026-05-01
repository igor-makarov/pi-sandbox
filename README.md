# @igormaka/pi-sandbox

A proper sandbox extension for [pi](https://github.com/badlogic/pi-mono), using the Anthropic Sandbox Runtime.

Overrides these tools to enforce sandbox rules:

- `bash`
- `read`
- `write`
- `edit`

The agent can request escalation for any of them by passing:

- `unsandboxed: true`

This triggers a user approval prompt before bypassing sandbox restrictions.

## Pre-approved Commands

Bash commands can also be pre-approved via `unsandboxedCommands` in the sandbox config. Matching commands bypass the sandbox without prompting the user.

Allowed syntax:

- `"npm test"` - exact match, allows only `npm test`
- `"git commit *"` - prefix match, allows `git commit -m "msg"` and `git commit --amend`

Commands using shell operators like `&&`, `|`, or `;` cannot be matched.
