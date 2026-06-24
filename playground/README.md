# Babylon Lite Playground

A modern, ES-first playground for [Babylon Lite](../packages/babylon-lite) — edit
TypeScript with full IntelliSense, run it live on a WebGPU canvas, and save & share
snippets. No UMD, no bundler step at author time: snippets are transpiled and run
straight in the browser.

## Requirements

- A **WebGPU-capable browser** (Chrome/Edge 113+). Babylon Lite is WebGPU-only.
- **Node 22+** and **pnpm 9+** (managed via corepack) to build/run locally.

## Getting started

It is a workspace package in this monorepo. Run it from the repo root:

```bash
pnpm dev:playground     # http://localhost:5175
pnpm build:playground   # production build into playground/dist
```

(or `pnpm dev` / `pnpm build` from inside `playground/`.)

The first run builds the self-hosted engine bundle and its type definitions, so it
takes a few extra seconds; subsequent runs are incremental.

## Architecture

The app shell (editor + toolbar) runs on the main page. User code is transpiled
in-browser and executed inside a sandboxed iframe that owns the WebGPU canvas, so
each run starts from a clean slate and can't break the surrounding UI.

```mermaid
flowchart LR
    editor["Monaco editor<br/>(TypeScript)"] -->|getValue| transpile["esbuild-wasm<br/>transpile → ESM"]
    transpile -->|module code| runner["Runner (main.ts)"]
    runner -->|new iframe + code| frame["runner.html<br/>sandboxed iframe"]
    frame -->|import map| engine["@babylonjs/lite<br/>(nightly or esm.sh)"]
    frame -->|"postMessage:<br/>console / error / stats / ran"| runner
    runner --> consolePane["Console panel"]
    snippets["snippet.babylonjs.com"] <-->|save / load| main["main.ts"]
    main --> editor
```

- **Editor** (`src/editor.ts`) — Monaco editing TypeScript, with the engine's
  rolled-up `.d.ts` wired in as the ambient `@babylonjs/lite` module for IntelliSense.
- **Transpile** (`src/transpile.ts`) — `esbuild-wasm` turns the snippet into an ES
  module in-browser, with an inline source map so runtime stacks read `playground.ts:<line>`.
- **Runner** (`src/runner.ts` + `public/runner.html`) — a sandboxed iframe hosts the
  WebGPU canvas and an import map resolving `@babylonjs/lite` to the chosen engine
  bundle. Each run recreates the iframe (clean teardown); it relays `console` /
  `error` / `stats` (FPS) / `ran` back over `postMessage`.
- **Engine** (`vite.engine.config.ts` → `src/engine-entry.ts`) — builds the workspace
  engine source into a self-contained ESM under `public/engine/dev/` ("nightly"). The
  version selector can instead load any published release on demand from the esm.sh
  CDN — no redeploy needed.
- **Glue** (`src/main.ts`) — wires the toolbar (examples, format, version selector,
  save), the run loop, snippet save/load + deep links, and embed mode.

### Project layout

```
playground/
├─ index.html                # App shell + toolbar + save dialog
├─ vite.config.ts            # App dev server (port 5175) + /snippet dev proxy
├─ vite.engine.config.ts     # Builds the self-hosted "nightly" engine bundle
├─ scripts/
│  └─ build-engine-types.ts  # Rolls up the engine .d.ts for Monaco IntelliSense
├─ public/
│  ├─ runner.html            # Sandboxed runner iframe (import map + message bridge)
│  └─ engine/dev/            # Generated nightly engine bundle (git-ignored)
└─ src/
   ├─ main.ts                # App glue: toolbar, run loop, snippets, embed, versions
   ├─ editor.ts              # Monaco setup + engine-typed IntelliSense
   ├─ transpile.ts           # esbuild-wasm TS → ESM
   ├─ runner.ts              # Owns/recreates the runner iframe
   ├─ examples.ts            # Built-in example snippets
   ├─ snippets.ts            # Save/load against the Babylon snippet server
   ├─ embed.ts               # ?embed modes + postMessage host bridge + deep links
   ├─ versions.ts            # Engine version list + esm.sh URL resolution
   └─ engine-entry.ts        # Re-exports the engine for the nightly bundle build
```

## Scripts

| Command (in `playground/`) | What it does                                              |
| -------------------------- | -------------------------------------------------------- |
| `pnpm dev`                 | `build:engine` + `build:types`, then start the dev server |
| `pnpm build`               | `build:engine` + `build:types`, then build the app        |
| `pnpm build:engine`        | Build the self-hosted nightly engine into `public/engine/dev/` |
| `pnpm build:types`         | Roll up the engine `.d.ts` for Monaco IntelliSense        |

`build:engine` and `build:types` run automatically before `dev`/`build` (via
`predev`/`prebuild`).

### Engine versions

The toolbar's version selector chooses which engine the runner loads:

- **Nightly (latest source)** — the self-hosted bundle built from this workspace.
  Its reported `VERSION` is stamped as `<latest>-nightly` (e.g. `1.4.0-nightly`),
  resolved from the newest `npm-lite-v*` git tag (overridable with `PACKAGE_VERSION`).
- **A published version** — fetched from `https://esm.sh/@babylonjs/lite@<version>`
  and applied via the runner's import map. The list is read from the npm registry.

`public/engine/dev/` and `dist/` are generated and git-ignored.

## Snippets

Snippets are saved to and loaded from the Babylon snippet server
(`snippet.babylonjs.com`), the same store the classic playground uses.

- **Save** (toolbar) — stores the current code and copies a permalink
  (`<origin>/#<id>`) to the clipboard. **Save with details…** (the caret) also
  captures a title, description, and tags.
- **Revisions** — re-saving a loaded snippet creates a new revision of the same id
  (`#<id>#<rev>`) rather than a brand-new snippet.
- **Load** — opening a `#<id>` (or `#<id>#<rev>`) permalink loads that snippet.

Snippets use the classic V2 manifest envelope plus a `kind: "babylon-lite"` marker,
so the format stays interoperable with the classic loader while letting the Lite
playground reject snippets authored for the classic engine.

## Embedding

The playground can be embedded in another page (the classic Babylon playground,
docs, blogs, …) via an iframe and driven over a namespaced `postMessage` API.

```html
<iframe src="https://lite-playground.example/?embed=runner"
        style="width: 100%; height: 480px; border: 0"></iframe>
```

Modes (`?embed=`):

- `runner` — canvas + console only (no editor); best for docs and demos.
- `split` (also `?embed`, `?embed=1`) — compact editor + canvas so readers can tweak.

Optionally pass `?embedOrigin=https://host.example` to restrict which origin the
embed accepts messages from and posts events to (defaults to `*`).

### postMessage API

Every message carries `channel: "babylon-lite-playground"`. The host sends:

| `type`     | fields            | effect                                        |
| ---------- | ----------------- | --------------------------------------------- |
| `loadCode` | `code`, `run?`    | replace the editor content; run if `run` true |
| `run`      | —                 | run the current code                          |
| `dispose`  | —                 | tear down the running scene                   |
| `getCode`  | —                 | request the current code (replies with `code`)|

The embed emits back to the host:

| `type`    | fields            | when                              |
| --------- | ----------------- | --------------------------------- |
| `ready`   | `mode`            | the embed is wired up and bootable|
| `console` | `level`, `text`   | a console line from the snippet   |
| `error`   | `text`            | an uncaught runtime error         |
| `stats`   | `fps`             | ~once a second while running      |
| `ran`     | —                 | a run finished importing          |
| `code`    | `code`            | reply to a `getCode` request      |

```js
const frame = document.querySelector("iframe");
const channel = "babylon-lite-playground";
window.addEventListener("message", (e) => {
    if (e.data?.channel !== channel) return;
    if (e.data.type === "ready") {
        frame.contentWindow.postMessage({ channel, type: "loadCode", code, run: true }, "*");
    }
});
```

### Deep links

- `#<id>` / `#<id>#<rev>` — load a saved snippet (see Snippets).
- `#code=<base64url>` — load inline source. The embed's **Open in Lite Playground**
  button uses this (or a snippet id when saved) to hand the current code off to the
  full standalone playground in a new tab.

## Deployment

The playground deploys to its own subdomain, **liteplayground.babylonjs.com**, via
`azure-pipelines-playground.yml` (mirrors the demos pipeline): it runs
`pnpm build:playground`, zips `playground/dist`, and POSTs it to the Babylon
deployment server, then purges the CDN. The pipeline checks out full history
(`fetchDepth: 0`) so the engine build can resolve the latest `npm-lite-v*` tag for
nightly version stamping. Re-running on each master push keeps nightly current;
chaining it after the npm-publish pipeline keeps it tracking the latest release.

Because the site is served from the domain root (a subdomain, not a subpath), all
runtime URLs resolve cleanly and no `base` rewriting is needed.

**Snippet saving in production:** saves POST directly to `snippet.babylonjs.com`,
whose CORS preflight is origin-allow-listed. `liteplayground.babylonjs.com` must be
added to that allow-list for saving to work in production (loading/sharing via GET
already works cross-origin). In local dev a same-origin Vite proxy (`/snippet`)
bypasses the preflight.

## Troubleshooting

- **Blank page on `pnpm dev`** — the dev server binds both IPv4 and IPv6 loopback
  (`host: true`) on a fixed port (`strictPort: true`, 5175). If 5175 is taken the
  server fails loudly instead of drifting; free the port or stop the other process.
- **"WebGPU not supported"** — use a WebGPU-capable browser (Chrome/Edge 113+). In
  some environments WebGPU needs to be enabled explicitly.
- **Saving fails locally** — dev routes saves through the Vite `/snippet` proxy to
  bypass the snippet server's origin-allow-listed preflight. If saves fail, confirm
  the dev server (not a static preview) is serving the app.
- **Stale engine after pulling changes** — rebuild the nightly bundle with
  `pnpm build:engine` (it also runs automatically via `predev`/`prebuild`).
