# Contributing to @babylonjs/lite-compat

This document is for **maintainers** of the compatibility layer. If you just want
to _consume_ the package, see [README.md](./README.md).

The compat layer is largely **maintained by an AI agent**: a Copilot-driven skill
reconciles it against upstream Babylon.js / Babylon Lite changes and lands new lab
scenes at parity, and an Azure DevOps pipeline runs that skill on a schedule (and
on demand) and opens a draft PR. Humans are needed for the parts that require a
real GPU or judgment — running parity/perf tests and reviewing/merging PRs.

```
update-compat-layer skill  ──drives──▶  edits + tests + COMPAT-STATUS.md
        ▲                                         │
        │ runs                                    ▼
azure-pipelines-compat-sync.yml  ──opens──▶  draft PR (human reviews)
```

---

## COMPAT-STATUS.md — the single source of truth

[COMPAT-STATUS.md](./COMPAT-STATUS.md) is the live record of what the layer
supports and how far it has been reconciled against upstream. Everything else —
the skill, the pipeline, the README table — reads from or updates it.

It tracks three things:

1. **Upstream sync markers.** `Last synced BJS commit` + `Last sync date` record
   the `BabylonJS/Babylon.js` `master` HEAD the surface was last reconciled
   against. These markers are **machine-read** by the skill — do not rename them.
2. **Lab-scene coverage.** The _Lab scene coverage_ section lists which oracle
   scenes render at pixel parity (MAD ≈ 0) through the compat layer, and the
   blocker for the rest.
3. **API parity.** A per-area status matrix with a `✅ / ⚡ / 🔧 / ❌` row for
   every public symbol of `@babylonjs/core` and `@babylonjs/loaders` (the
   completeness invariant: every public symbol has a row).

> **Scope is `@babylonjs/core` + `@babylonjs/loaders` only.** Everything else
> (`gui`, `inspector`, `post-processes`, `serializers`, WebXR, audio, …) is out
> of scope. A few historical out-of-core rows are kept for reader context but are
> not part of the audited surface.

---

## The `update-compat-layer` skill

[`.github/copilot/skills/update-compat-layer.md`](../../.github/copilot/skills/update-compat-layer.md)
is the skill that advances the layer. Every run makes progress on three fronts:

| Task                                      | Goal                                                                   | Tracked in `COMPAT-STATUS.md` by                        |
| ----------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| **1 — Upstream diffs**                    | React to what changed in Babylon.js + Babylon Lite since the last sync | the `Last synced BJS commit` / `Last sync date` markers |
| **2 — Lab-scene coverage** (required win) | Land **at least one** more oracle scene at MAD ≈ 0                     | the _Lab scene coverage_ section                        |
| **3 — API parity**                        | Add/upgrade core + loaders symbols (real impl or honest stub)          | the per-area status matrix                              |

Task 2 is the headline deliverable of every run: a run that ships zero new working
scenes is considered incomplete.

When you change the surface, keep the layer **honest**: an unsupported API should
throw `LiteCompatError` (via the `unsupported()` helper) rather than silently
mis-rendering, and the matching row in `COMPAT-STATUS.md` must be updated in the
same change.

The skill also keeps the consumer-facing **Supported APIs at a glance** table in
[README.md](./README.md) in sync: that table is a per-feature-area roll-up of the
`COMPAT-STATUS.md` matrix, so whenever a change flips an area's overall status it
updates the README row too (without leaking per-symbol detail or internal-doc
links, since the README ships to npm).

---

## Marking a lab scene ready for compat

The repo's lab renders the Babylon.js oracle scenes (`lab/lite/src/bjs/sceneN.ts`)
through the compat layer at `/compat/sceneN.html` — see the **Compat** tab in the
lab. This is the behavioural cross-check for the API surface.

A scene is opted into the Compat tab by setting `"compatParity": true` on its entry
in [scene-config.json](../../scene-config.json):

```jsonc
{
    "id": 1,
    "slug": "scene1-boombox",
    "name": "Scene 1 — BoomBox PBR",
    // …
    "compatParity": true, // ← renders through the compat layer in the Compat tab
}
```

How the redirect works: the lab's `compatScenesPlugin`
([lab/vite.config.ts](../../lab/vite.config.ts)) serves the parallel
`/compat/sceneN.html` route and rewrites the scene's `@babylonjs/*` imports onto
the compat layer using the **same shared mapping table** (`bundler-resolve.ts`,
via `mapBabylonImport`) that backs the published bundler plugins — so the lab
harness and the shipped Vite/Rollup/Webpack/esbuild plugins validate the exact
same redirects.

Only flip `compatParity` to `true` once the compat render matches the native Lite
port at MAD ≈ 0, and add the scene to the _Working_ list in `COMPAT-STATUS.md`.
Scenes with no Babylon.js oracle source (Lite-only scenes) are excluded.

---

## The automated maintenance pipeline

[azure-pipelines-compat-sync.yml](../../azure-pipelines-compat-sync.yml) runs the
skill end-to-end via the GitHub Copilot CLI and opens a **draft PR** with whatever
it changed, so the compat layer can track upstream with no human authoring.

- **Triggers:** a daily schedule, manual runs, and a GitHub issue labeled
  `compat` (bridged GitHub → ADO by
  [.github/workflows/compat-sync-trigger.yml](../../.github/workflows/compat-sync-trigger.yml),
  which fetches the issue body and injects it into the agent prompt).
- **Two halves:** the agent step (read + edit only), then a deterministic PR driver
  ([scripts/open-compat-sync-pr.ts](../../scripts/open-compat-sync-pr.ts)) that
  **independently re-validates** — compat unit tests + typecheck, never trusting
  the agent's self-report — then branches, commits, pushes, and opens the draft PR
  with the validation results in the body.
- **Humans stay in the loop** for review and for the GPU-bound checks (parity /
  perf) that can't run on the pipeline's headless agent.

The prompt is assembled by
[scripts/build-compat-sync-prompt.mjs](../../scripts/build-compat-sync-prompt.mjs).

---

## Local development

```sh
# Unit tests (GPU-free): math, observables, engine/scene APIs, bundler resolver
pnpm exec vitest run --project compat

# Typecheck the package against the linked babylon-lite types
pnpm exec tsc -p packages/babylon-lite-compat/tsconfig.json --noEmit

# Build the publishable dist (ESM + .d.ts)
pnpm --filter @babylonjs/lite-compat build

# Run the lab to compare /compat/sceneN against /lite/sceneN
pnpm --filter lab dev
```

CI runs the compat unit tests + typecheck + build on every PR (the **Compat Layer**
job in [azure-pipelines.yml](../../azure-pipelines.yml)); it does **not** publish
the package. Pixel-parity and bundle-size gates run in the lab/CI on a real GPU.
