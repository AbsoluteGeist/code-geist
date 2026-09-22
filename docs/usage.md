# Usage

[Back to README](../README.md)

Before running a live task, [configure a model provider](configuration.md) and review the [execution boundaries](execution-boundaries.md).

## Run a coding task

1. Enter a concrete task with observable acceptance criteria.
2. Enter the absolute path to an existing Git repository with at least one commit.
3. Set a verification command, such as `npm test`, `node --test`, or `python -m pytest`.
4. If needed, add an optional setup command such as `npm ci` in advanced options. It runs once in the new worktree before the agent starts.
5. Start the task. Inspect the activity timeline, Jev decisions, changed files, and verification output. Stop is available while running.
6. Review the retained worktree and download the patch. Apply it yourself to the appropriate source revision after review, for example with `git apply --check /path/to/downloaded.patch` followed by `git apply /path/to/downloaded.patch`.

The first turn of a live conversation creates a Git worktree on a `feat/agent-…` branch, starting from the source repository's committed `HEAD`. Later turns reuse that worktree, including its uncommitted changes. Uncommitted changes and untracked files from the source checkout are not copied. The agent's tools edit the worktree; the source checkout stays untouched. Dependency directories are not copied, so use a setup command when verification needs them.

A Code run can finish successfully only after it has a nonempty diff and passing verification for the current revision. Passing tests are evidence for the configured checks, not a guarantee that every aspect of the requested behavior is correct; review the diff and the task's acceptance criteria. Budget exhaustion, failed requests, and cancellation remain visible as incomplete runs.

## Continue a conversation

**Chat** is the default view. Send another message to make the next change in the same workspace, or choose **Ask** for a read-only discussion. Ask turns can inspect files and answer without changing code or running commands. **Code** turns retain the current-revision verification gate. The scripted demo supports a documentation-only follow-up and a canned explanation; it does not pretend to implement arbitrary prompts.

### Layout and inspection

Use the **Tabs / Split** control in the conversation header to choose a layout. Split keeps Chat and its composer on the left while Activity, Changes, and Verification share the right column. The columns scroll independently, and switching inspection tabs preserves the chat draft. Layout preference is remembered; narrow screens use tabs automatically.

### Queued messages

Messages submitted while a turn is running are queued and executed in order after successful completion. A failed, stopped, or budget-exhausted turn pauses its existing queue until you continue it or send a new instruction. Submission IDs prevent HTTP retries from duplicating messages. Different conversations use independent workspaces; each conversation executes one turn at a time.

### Resume an interrupted turn

**Continue +12** adds twelve model rounds to the same interrupted turn, retaining its model history, workspace, tool records and cumulative usage. Every model request receives its remaining budget and current verification state; the last six rounds include explicit closing guidance. A later executed turn prevents resuming an earlier turn over newer changes. Cancelled queued messages never become workspace owners.

Private checkpoints in `.codegeist/checkpoints/` preserve exact provider continuation messages at model-response and tool-result boundaries with file permissions `0600`. Confirmed results are reused. Tools whose execution was interrupted are reconciled as unknown; commands are not blindly replayed. Setup runs once on the first Code turn that needs it, and interrupted setup is not automatically repeated. Manual workspace changes invalidate stale verification. Older runs without checkpoints support explicitly labeled fresh-context recovery in their retained workspace.

### Streaming and replay

Public conversation events are journaled under `.codegeist/conversations/` with monotonic sequence IDs. The UI reconnects using snapshots and ordered replay without duplicating assistant text or usage. Model text and command output arrive incrementally; full request/response details remain available in Activity. Switch the inspection turn to review that turn's trace, saved diff and verification.

### Usage metrics

The footer can show this turn or the entire conversation: user turns, model steps, LLM/tool durations, first-token latency, generation throughput, cached-input share, and confirmed input/output tokens. Jev has a separate breakdown. Usage is accounted once per request; cached-input and reasoning tokens are subsets, not additional totals. Unknown provider metrics display `—`; tokens are not estimated. While a request runs, the footer labels the confirmed totals.

Chat messages preserve the full conversation within the provider's context limit; automatic history summarization is not implemented.

See [Activity traces](activity-traces.md) for request details and log exports. Storage paths above use the default `CODEGEIST_DATA_DIR`; see [Configuration](configuration.md#environment-variables) to change it.
