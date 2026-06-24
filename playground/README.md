# Babylon Lite Playground

A modern, ES-first playground for [Babylon Lite](../packages/babylon-lite) — edit
TypeScript, run it live on a WebGPU canvas, and (soon) save & share snippets.

It is a workspace package in this monorepo. Run it from the repo root:

```bash
pnpm dev:playground     # http://localhost:5175
pnpm build:playground   # production build into playground/dist
```

(or `pnpm dev` / `pnpm build` from inside `playground/`.)

## How it works

- **Editor** — Monaco, editing TypeScript.
- **Transpile** — `esbuild-wasm` turns the snippet into an ES module in-browser.
- **Runner** — a sandboxed iframe (`public/runner.html`) hosts the WebGPU canvas
  and an import map resolving `@babylonjs/lite` to the self-hosted engine bundle.
- **Engine** — `vite.engine.config.ts` builds the workspace engine source into a
  self-contained ESM under `public/engine/dev/` ("nightly"). This runs
  automatically before `dev`/`build`. The version selector can also load any
  published release on demand from the esm.sh CDN — no redeploy needed.

### Engine versions

The toolbar's version selector chooses which engine the runner loads:

- **Nightly (latest source)** — the self-hosted bundle built from this workspace.
  Its reported `VERSION` is stamped as `<latest>-nightly` (e.g. `1.4.0-nightly`),
  resolved from the newest `npm-lite-v*` git tag (overridable with `PACKAGE_VERSION`).
- **A published version** — fetched from `https://esm.sh/@babylonjs/lite@<version>`
  and applied via the runner's import map. The list is read from the npm registry.

`public/engine/dev/` and `dist/` are generated and git-ignored.

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
