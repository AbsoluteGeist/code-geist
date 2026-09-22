# Code Geist

An experimental local coding-agent workbench using Jev for model routing, with tool execution and verification in Git worktrees.

**Experimental project:** Code Geist is a prototype for trying out coding-agent workflows. Features, configuration, and saved data formats may change as the experiments evolve.

Give it a task and a Git repository, then inspect model decisions, code changes, and real verification results in an English-language interface with light and dark themes.

The harness owns execution. An OpenAI-compatible generative model writes code and calls tools. Jev selects a configured model, ranks context, and classifies failed verification. Every decision has an explicit source: Jev, a deterministic fallback, a user override, or the scripted demo.

## Quick start

Requires Node.js 22.12+ and Git. Run these commands from the repository root:

```sh
npm install
cp .env.example .env
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) and choose **Run demo**. No API keys are required: model actions and Jev judgments are scripted, while file changes, Git diffs, and test execution are real.

To run your own tasks, [configure a model provider](docs/configuration.md), then follow the [usage guide](docs/usage.md).

Both services listen on `0.0.0.0` by default. Set `HOST=127.0.0.1` in `.env` before starting to limit access to this machine. The workbench has no authentication and runs commands under your OS account; use trusted repositories and networks. Read the [execution boundaries](docs/execution-boundaries.md) before running live tasks or enabling LAN access.

## Documentation

| Guide | Contents |
| --- | --- |
| [Getting started](docs/getting-started.md) | Installation, demo, local builds, and LAN access |
| [Configuration](docs/configuration.md) | Model providers, Jev routing, streaming, and environment variables |
| [Usage](docs/usage.md) | Coding tasks, conversations, queues, continuation, and usage metrics |
| [Activity traces](docs/activity-traces.md) | Request inspection, trace storage, and log exports |
| [Execution boundaries](docs/execution-boundaries.md) | Local execution, data handling, limitations, and cleanup |
| [Development](docs/development.md) | Checks and source layout |

## License

[MIT](LICENSE). Bundled fonts retain their separate SIL Open Font License 1.1 notices: [DM Sans](src/assets/fonts/dm-sans-LICENSE.txt) and [IBM Plex Mono](src/assets/fonts/ibm-plex-mono-LICENSE.txt).
