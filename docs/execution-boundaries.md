# Execution boundaries

[Back to README](../README.md)

Code Geist is an experimental project. Its execution model is intended for trusted local use; features, configuration, and saved data formats may change.

## Trusted local execution

This workbench runs **trusted local repositories and commands**, under your OS account. A Git worktree isolates source changes; it is not an OS security sandbox. Setup commands and test code can execute local code. The server supports access from your trusted LAN through any hostname and rejects foreign browser origins. It has no authentication and does not support multi-user or public hosting.

## Tools and commands

Model tools are restricted to listing, reading, searching, writing, running the preconfigured verification command, and finishing. File tools reject path traversal, symlinks, and `.git` / `.env` access. Commands use `shell: false`, have time limits, and receive a restricted environment without provider API keys. Compound shell expressions such as `npm ci && npm test` are unsupported: use separate setup and verification fields, or a repository script.

## Provider data

API calls can send the task, selected source snippets, tool outputs, and generated code to your configured providers.

## Retention and cleanup

Runs and workspaces are retained in `.codegeist/` (ignored by Git), or the directory set by `CODEGEIST_DATA_DIR`. History and completed results survive restarts; active turns become interrupted and can be continued. Untouched queued messages remain queued; they start when their preceding turn has completed. Remove retained live worktrees with `git worktree remove /absolute/worktree/path` when no longer needed, after saving any desired changes.

## Current limits

Automatic merging, deployment, arbitrary agent-chosen shell commands, and unbounded execution are outside the current scope. Automatic conversation history summarization is not implemented.

See [Getting started](getting-started.md#lan-access) for LAN access, the [usage guide](usage.md#resume-an-interrupted-turn) for continuation, and [Activity traces](activity-traces.md) for stored logs.
