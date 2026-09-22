# Development

[Back to README](../README.md)

See [Getting started](getting-started.md) for installation and the development server. Run the commands below from the repository root.

## Checks

```sh
npm test
npm run build
```

The build runs TypeScript checks before bundling the frontend. Use `npm run check` to run the type check on its own.

The automated suite uses actual temporary Git repositories and the Node test runner. Provider contract tests use local HTTP fixtures; they do not spend API credits. End-to-end live-provider integration should additionally be checked with your own configured credentials.

## Source layout

| Path | Responsibility |
| --- | --- |
| [`src/`](../src/) | React workbench, themes, chat, activity, diff, and verification views |
| [`src/conversation-client.ts`](../src/conversation-client.ts) | Conversation snapshots and ordered event replay in the UI |
| [`shared/types.ts`](../shared/types.ts) | API and event contracts |
| [`shared/metrics.ts`](../shared/metrics.ts) | Usage aggregation and derived performance metrics |
| [`server/app.ts`](../server/app.ts) | Local HTTP API and server-sent events |
| [`server/index.ts`](../server/index.ts) | Server startup and listen addresses |
| [`server/store.ts`](../server/store.ts) | Persistent run records and restart recovery |
| [`server/conversations.ts`](../server/conversations.ts) | Per-conversation queues, durable public events, replay, and continuation |
| [`server/checkpoint.ts`](../server/checkpoint.ts) | Private resumable execution context and workspace identity checks |
| [`server/harness.ts`](../server/harness.ts) | Bounded agent loop and completion checks |
| [`server/tools.ts`](../server/tools.ts) | Validated filesystem and verification tools |
| [`server/workspace.ts`](../server/workspace.ts) | Git worktrees, processes, and patches |
| [`server/providers.ts`](../server/providers.ts) | Generation and Jev adapters |
| [`server/model-config.ts`](../server/model-config.ts) | Server-side provider configuration |
| [`server/trace.ts`](../server/trace.ts) | Detailed activity traces, payload storage, and credential redaction |
| [`server/network.ts`](../server/network.ts) | Host and origin validation |
| [`server/demo.ts`](../server/demo.ts) | Scripted demo with real execution |
| [`tests/`](../tests/) | Runtime, workspace, provider, and API checks |
