# Activity traces

[Back to README](../README.md)

## Inspect a run

New runs record a trace for each model request, Jev evaluation, tool call, and setup command, including system/user inputs, parent call relationships, start/end times, duration, status, and token usage when the provider reports it. The Activity view combines a multi-lane timeline, searchable event list, and a detail inspector with Summary, Request, Response, Schema, and Timing tabs.

Model and Jev details include their actual HTTP request bodies, response bodies, HTTP status and headers. Provider-returned fields remain available in the detail view, including continuation data. Tool details include their arguments, definition, and returned result. Failed responses, malformed JSON, timeouts and cancellations are recorded on the original request. Any provider or tool output limit is explicitly identified instead of silently representing partial output as complete.

## Storage and exports

Full payloads are saved separately under `.codegeist/traces/<run-id>/`; live updates contain compact event metadata. Select an event to load its full details, or use **Download log** to export the run as NDJSON. API credentials, authorization/cookie headers and sensitive credential fields are redacted before writing. Traces still contain task text and source code, so treat exported logs as project data.

## Older runs and the demo

Runs created before detailed tracing remain readable using their saved events. Missing historical requests/responses cannot be reconstructed and are labeled as unavailable. The demo explicitly labels scripted decisions and records its actual tool execution.

Storage paths above use the default `CODEGEIST_DATA_DIR`. See [Configuration](configuration.md#environment-variables) to change it and [Execution boundaries](execution-boundaries.md) for data handling and retention.
