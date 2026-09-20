# Code Geist

A local coding-agent workbench. Give it a task and a Git repository; inspect model routing, tool execution, code changes, and real verification results in one English-language interface with light and dark themes.

The harness owns execution. An OpenAI-compatible generative model writes code and calls tools. Jev selects a configured model, ranks context, and classifies failed verification. Every decision has an explicit source: Jev, a deterministic fallback, a user override, or the scripted demo.

## Start

Requires Node.js 22.12+ and Git.

```sh
npm install
cp .env.example .env
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) on this machine. From another device on the same LAN, open `http://<this-machine-LAN-IP>:5173`; Vite prints the network address at startup and proxies API requests to port `4317` (or your configured `PORT`). Both services listen on `0.0.0.0` by default. Set `HOST=127.0.0.1` in `.env` to allow access only from this machine.

**Run demo** needs no API keys. It creates a small Git repository, reproduces failing slugify tests, edits the implementation, adds regression tests, and runs the real Node test runner. Its model actions and Jev judgments are explicitly scripted; filesystem changes, Git diffs, and verification are real.

For a single-process production build:

```sh
npm run build
npm start
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317), or `http://<this-machine-LAN-IP>:4317` from another device. The server prints its available addresses at startup. Use the configured `PORT` if changed.

Any IP address or hostname that resolves to this machine can be used; neither Vite nor the API requires a hostname allowlist. Browser requests still use same-origin checks. Restart after changing the listen address or port. LAN access has no login, so use a trusted network; anyone who can access the workbench can start tasks under your OS account.

## Connect models

For one provider, set these values in `.env`:

```dotenv
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-flash
OPENAI_API_KEY=your-key
TYPESAFE_API_KEY=your-typesafe-key
TYPESAFE_MODEL=jev-1.13.0
```

The generation adapter uses `/chat/completions` with function tools and streaming by default. Choose a model that supports that protocol. It preserves provider-specific assistant fields such as DeepSeek's `reasoning_content` within a turn. Models requiring the Responses API need a separate adapter. An endpoint returning ordinary JSON is still supported; use `streaming: false` in a model profile (or `OPENAI_STREAMING=false` for a single provider) to explicitly disable SSE. Set `streamUsage: true` / `OPENAI_STREAM_USAGE=true` only if the endpoint supports `stream_options.include_usage`. Requests are never silently retried in another mode.

For DeepSeek, Zhipu, and other providers together:

```sh
cp models.config.example.json models.config.json
```

Edit each profile's `baseURL`, `model`, and capability `description`; set the matching `apiKeyEnv` variable in `.env`. Only profiles with a configured key can run. Replace placeholder model names and endpoints with those available to your account. `models.config.json` takes precedence over the single-provider variables.

```json
{
  "defaultModel": "everyday",
  "models": [
    {
      "id": "everyday",
      "name": "Everyday coding",
      "baseURL": "https://api.deepseek.com",
      "model": "deepseek-flash",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "description": "Focused bug fixes and everyday implementation tasks."
    },
    {
      "id": "reasoning",
      "name": "Complex changes",
      "baseURL": "https://YOUR_PROVIDER/v1",
      "model": "YOUR_TOOL_CAPABLE_MODEL",
      "apiKeyEnv": "CUSTOM_API_KEY",
      "description": "Complex debugging and refactoring across multiple modules."
    }
  ]
}
```

Choose **Auto** to let Jev match the task to these descriptions, or select a model explicitly. A missing Jev key, failed judgment, or low-confidence route uses the configured default and records the fallback. A single available model needs no routing request. Jev's route is a capability match based on your descriptions, not an independent model benchmark. Tune descriptions and the confidence threshold against your own tasks.

Restart the server after editing `.env`. Model profile files are read when requests are handled; reload the page to refresh the list. API keys stay on the server and are never returned by the configuration endpoint.

References: [DeepSeek API](https://api-docs.deepseek.com/), [Zhipu documentation](https://docs.bigmodel.cn/), [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Jev API](https://docs.typesafe.ai/api).

## Run a coding task

1. Enter a concrete task with observable acceptance criteria.
2. Enter the absolute path to an existing Git repository with at least one commit.
3. Set a verification command, such as `npm test`, `node --test`, or `python -m pytest`.
4. If needed, add an optional setup command such as `npm ci` in advanced options. It runs once in the new worktree before the agent starts.
5. Start the task. Inspect the activity timeline, Jev decisions, changed files, and verification output. Stop is available while running.
6. Review the retained worktree and download the patch. Apply it yourself to the appropriate source revision after review, for example with `git apply --check /path/to/downloaded.patch` followed by `git apply /path/to/downloaded.patch`.

The first turn of a live conversation creates a Git worktree on a `feat/agent-…` branch, starting from the source repository's committed `HEAD`. Later turns reuse that worktree, including its uncommitted changes. Uncommitted changes and untracked files from the source checkout are not copied. The agent's tools edit the worktree; the source checkout stays untouched. Dependency directories are not copied, so use a setup command when verification needs them.

A run can finish successfully only after it has a nonempty diff and passing verification for the current revision. Passing tests are evidence for the configured checks, not a guarantee that every aspect of the requested behavior is correct; review the diff and the task's acceptance criteria. Budget exhaustion, failed requests, and cancellation remain visible as incomplete runs.

## Continue a conversation

**Chat** is the default view. Send another message to make the next change in the same workspace, or choose **Ask** for a read-only discussion. Ask turns can inspect files and answer without changing code or running commands. **Code** turns retain the current-revision verification gate. The scripted demo supports a documentation-only follow-up and a canned explanation; it does not pretend to implement arbitrary prompts.

Messages submitted while a turn is running are queued and executed in order after successful completion. A failed, stopped, or budget-exhausted turn pauses its existing queue until you continue it or send a new instruction. Submission IDs prevent HTTP retries from duplicating messages. Different conversations use independent workspaces; each conversation executes one turn at a time.

**Continue +12** adds twelve model rounds to the same interrupted turn, retaining its model history, workspace, tool records and cumulative usage. Every model request receives its remaining budget and current verification state; the last six rounds include explicit closing guidance. A later executed turn prevents resuming an earlier turn over newer changes. Cancelled queued messages never become workspace owners.

Private checkpoints in `.codegeist/checkpoints/` preserve exact provider continuation messages at model-response and tool-result boundaries with file permissions `0600`. Confirmed results are reused. Tools whose execution was interrupted are reconciled as unknown; commands are not blindly replayed. Setup runs once on the first Code turn that needs it, and interrupted setup is not automatically repeated. Manual workspace changes invalidate stale verification. Older runs without checkpoints support explicitly labeled fresh-context recovery in their retained workspace.

Public conversation events are journaled under `.codegeist/conversations/` with monotonic sequence IDs. The UI reconnects using snapshots and ordered replay without duplicating assistant text or usage. Model text and command output arrive incrementally; full request/response details remain available in Activity. Switch the inspection turn to review that turn's trace, saved diff and verification.

The footer can show this turn or the entire conversation: user turns, model steps, LLM/tool durations, first-token latency, generation throughput, cached-input share, and confirmed input/output tokens. Jev has a separate breakdown. Usage is accounted once per request; cached-input and reasoning tokens are subsets, not additional totals. Unknown provider metrics display `—`; tokens are not estimated. While a request runs, the footer labels the confirmed totals. Chat messages preserve the full conversation within the provider's context limit; automatic history summarization is not implemented.

## Inspect activity traces

New runs record a trace for each model request, Jev evaluation, tool call, and setup command, including system/user inputs, parent call relationships, start/end times, duration, status, and token usage when the provider reports it. The Activity view combines a multi-lane timeline, searchable event list, and a detail inspector with Summary, Request, Response, Schema, and Timing tabs.

Model and Jev details include their actual HTTP request bodies, response bodies, HTTP status and headers. Provider-returned fields remain available in the detail view, including continuation data. Tool details include their arguments, definition, and returned result. Failed responses, malformed JSON, timeouts and cancellations are recorded on the original request. Any provider or tool output limit is explicitly identified instead of silently representing partial output as complete.

Full payloads are saved separately under `.codegeist/traces/<run-id>/`; live updates contain compact event metadata. Select an event to load its full details, or use **Download log** to export the run as NDJSON. API credentials, authorization/cookie headers and sensitive credential fields are redacted before writing. Traces still contain task text and source code, so treat exported logs as project data.

Runs created before detailed tracing remain readable using their saved events. Missing historical requests/responses cannot be reconstructed and are labeled as unavailable. The demo explicitly labels scripted decisions and records its actual tool execution.

## Execution boundaries

This MVP runs **trusted local repositories and commands**, under your OS account. A Git worktree isolates source changes; it is not an OS security sandbox. Setup commands and test code can execute local code. The server supports access from your trusted LAN through any hostname and rejects foreign browser origins. It has no authentication and does not support multi-user or public hosting.

Model tools are restricted to listing, reading, searching, writing, running the preconfigured verification command, and finishing. File tools reject path traversal, symlinks, and `.git` / `.env` access. Commands use `shell: false`, have time limits, and receive a restricted environment without provider API keys. Compound shell expressions such as `npm ci && npm test` are unsupported: use separate setup and verification fields, or a repository script. API calls can send the task, selected source snippets, tool outputs, and generated code to your configured providers.

Runs and workspaces are retained in `.codegeist/` (ignored by Git). History and completed results survive restarts; active turns become interrupted and can be continued. Untouched queued messages remain queued; they start when their preceding turn has completed. Remove retained live worktrees with `git worktree remove /absolute/worktree/path` when no longer needed, after saving any desired changes. Automatic merging, deployment, arbitrary agent-chosen shell commands, and unbounded execution are outside this MVP.

## Configuration

| Variable | Purpose |
| --- | --- |
| `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY` | Single generation provider |
| `OPENAI_STREAMING`, `OPENAI_STREAM_USAGE` | Single-provider SSE switch (default true) and optional usage request flag (default false) |
| `CODEGEIST_MODELS_FILE` | Optional model profile JSON path; defaults to `models.config.json` |
| `TYPESAFE_API_KEY` | Enables Jev judgments |
| `TYPESAFE_BASE_URL` | Defaults to `https://api.typesafe.ai/v1` |
| `TYPESAFE_MODEL` | Defaults to pinned `jev-1.13.0` |
| `TYPESAFE_ROUTING_MIN_CONFIDENCE` | Routing threshold; defaults to `0.55` |
| `MODEL_TIMEOUT_MS`, `TYPESAFE_TIMEOUT_MS` | Provider request deadlines |
| `CODEGEIST_DATA_DIR` | Run/workspace storage; defaults to `.codegeist` |
| `HOST` | API and Vite listen address; defaults to `0.0.0.0`. Use `127.0.0.1` for local access only, or `::` for IPv6 |
| `PORT` | API/server port; defaults to `4317`. Vite's API proxy follows this value automatically; the development UI stays on `5173` |

## Develop and verify

```sh
npm test
npm run build
```

The automated suite uses actual temporary Git repositories and the Node test runner. Provider contract tests use local HTTP fixtures; they do not spend API credits. End-to-end live-provider integration should additionally be checked with your own configured credentials.

```text
src/                 React workbench, theme, activity/diff/test views
shared/types.ts      API and event contracts
server/app.ts        Local HTTP API and server-sent events
server/store.ts      Persistent run records and restart recovery
server/conversations.ts  Per-conversation queues, durable public events, replay and continuation
server/checkpoint.ts Private resumable execution context and workspace identity checks
server/harness.ts    Bounded agent loop and completion checks
server/tools.ts      Validated filesystem and verification tools
server/workspace.ts  Git worktrees, processes, and patches
server/providers.ts Generation and Jev adapters
server/model-config.ts  Server-side provider configuration
server/demo.ts       Scripted demo with real execution
tests/              Runtime, workspace, provider, and API checks
```
