# Configuration

[Back to README](../README.md)

The [scripted demo](getting-started.md#try-the-demo) needs no API keys. Live coding tasks need a configured generation provider; Jev is optional.

## Single provider

Start with [`.env.example`](../.env.example). For one provider, set these values in `.env`:

```dotenv
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-flash
OPENAI_API_KEY=your-key
TYPESAFE_API_KEY=your-typesafe-key
TYPESAFE_MODEL=jev-1.13.0
```

Use an endpoint and model available to your account. Leave `TYPESAFE_API_KEY` empty to run without Jev judgments.

## Protocol and streaming

The generation adapter uses `/chat/completions` with function tools and streaming by default. Choose a model that supports that protocol. It preserves provider-specific assistant fields such as DeepSeek's `reasoning_content` within a turn. Models requiring the Responses API need a separate adapter.

An endpoint returning ordinary JSON is still supported; use `streaming: false` in a model profile (or `OPENAI_STREAMING=false` for a single provider) to explicitly disable SSE. Set `streamUsage: true` / `OPENAI_STREAM_USAGE=true` only if the endpoint supports `stream_options.include_usage`. Requests are never silently retried in another mode.

## Multiple providers

For DeepSeek, Zhipu, and other providers together, copy the [example profiles](../models.config.example.json) from the repository root:

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

## Jev routing

Choose **Auto** to let Jev match the task to these descriptions, or select a model explicitly. A missing Jev key, failed judgment, or low-confidence route uses the configured default and records the fallback. A single available model needs no routing request.

Jev's route is a capability match based on your descriptions, not an independent model benchmark. Tune descriptions and the confidence threshold against your own tasks.

## Applying changes

Restart the server after editing `.env`. Model profile files are read when requests are handled; reload the page to refresh the list. API keys stay on the server and are never returned by the configuration endpoint.

## Environment variables

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

## Provider references

- [DeepSeek API](https://api-docs.deepseek.com/)
- [Zhipu documentation](https://docs.bigmodel.cn/)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Jev API](https://docs.typesafe.ai/api)
