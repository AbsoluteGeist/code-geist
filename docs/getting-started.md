# Getting started

[Back to README](../README.md)

Code Geist is an experimental workbench for trusted local repositories and commands. See the [execution boundaries](execution-boundaries.md) before running live tasks or exposing it on your LAN.

## Requirements

- Node.js 22.12 or later
- Git

Run all commands below from the repository root.

## Development server

```sh
npm install
cp .env.example .env
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) on this machine. Vite serves the UI and proxies API requests to port `4317` (or your configured `PORT`). Both services listen on `0.0.0.0` by default. Set `HOST=127.0.0.1` in `.env` before starting to allow access only from this machine.

## Try the demo

**Run demo** needs no API keys. It creates a small Git repository, reproduces failing slugify tests, edits the implementation, adds regression tests, and runs the real Node test runner. Its model actions and Jev judgments are explicitly scripted; filesystem changes, Git diffs, and verification are real.

For your own repositories, [connect a model provider](configuration.md) and follow the [usage guide](usage.md).

## Run a built version

For a single-process local build:

```sh
npm run build
npm start
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). Use the configured `PORT` if changed. This serves the built UI from the API server; it does not change the project's experimental status or execution boundaries.

## LAN access

From another device on the same LAN, open `http://<this-machine-LAN-IP>:5173` for the development server or `http://<this-machine-LAN-IP>:4317` for the built version. Vite prints the network address at startup, and the API server prints its available addresses. Use the configured `PORT` for the built version if changed.

Any IP address or hostname that resolves to this machine can be used; neither Vite nor the API requires a hostname allowlist. Browser requests still use same-origin checks. Restart after changing the listen address or port.

LAN access has no login, so use a trusted network; anyone who can access the workbench can start tasks under your OS account. Public hosting and multi-user use are unsupported.
