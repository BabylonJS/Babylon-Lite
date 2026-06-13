# Update the Babylon Lite Compat Layer

You maintain `@babylonjs/lite-compat` — the Babylon.js-shaped compatibility layer
that sits on top of the Babylon Lite public API (package at
`packages/babylon-lite-compat/`). Your job in this skill is to **reconcile the
compat layer with what has changed in both Babylon.js and Babylon Lite since the
last sync**, implement what is now possible, add tests, and update the status
file.

The single source of truth for sync state is
`packages/babylon-lite-compat/COMPAT-STATUS.md`.

---

## Scope (core + loaders only — non-negotiable)

This skill covers **only** the public API of two Babylon.js packages:

- `@babylonjs/core` → `packages/dev/core/src` in `BabylonJS/Babylon.js`
- `@babylonjs/loaders` → `packages/dev/loaders/src` in `BabylonJS/Babylon.js`

**Everything else is explicitly out of scope** and must not be enumerated,
implemented, or stubbed by this skill: `@babylonjs/gui`, `@babylonjs/inspector`,
`@babylonjs/materials`, `@babylonjs/post-processes`, `@babylonjs/procedural-textures`,
`@babylonjs/serializers`, `@babylonjs/node-editor`, and any WebXR/audio surfaces that
live outside core. If you encounter one of these, ignore it — do not add a row for it.

> The `COMPAT-STATUS.md` matrix may retain historical rows for a few out-of-core
> areas (GUI, audio, XR) for reader context, but the coverage audit below is scoped
> strictly to core + loaders.

---

## The completeness invariant (read this first)

**Every public symbol exported from BJS core + loaders MUST have a row in
`COMPAT-STATUS.md`.** A symbol with no row is an undetected gap. Diffs alone cannot
guarantee this — they only surface what *changed*, never what already existed and
was never triaged.

You therefore run **two phases every time**:

- **Phase A — Coverage audit (full enumeration).** Enumerate the *entire* core +
  loaders export surface and reconcile it against the status matrix. This is what
  guarantees thoroughness; it does not depend on diffs.
- **Phase B — Incremental diff.** Use the BJS/Lite diffs since the last sync to
  prioritise *what changed*, so you spend effort where it's most likely to matter.

Phase A is mandatory and is the gate. Phase B is an accelerator, not a substitute.

---

## Phase A — Coverage audit (mandatory, full enumeration)

1. **Read `packages/babylon-lite-compat/COMPAT-STATUS.md`** and extract the
   `Last synced BJS commit` SHA (`LAST_BJS_SHA`) and `Last sync date`.

2. **Enumerate the full BJS core + loaders public API surface.** Use the published
   **TypeScript declaration files (`.d.ts`)** as the authoritative shape — they
   resolve the complete picture the source barrels do not: every exported symbol,
   the full class-inheritance chain, and each class's members. Read them from the
   built declarations (the repo's `dist`, or the npm tarballs of `@babylonjs/core`
   and `@babylonjs/loaders`), starting at each package's `index.d.ts` and following
   the re-exports. Fall back to the source `index.ts` barrels on GitHub raw at
   `master` if a `.d.ts` is unavailable.
    - Capture every **exported top-level symbol** (the things a user would
      `import { X }`) and, for classes, the **base class it extends**.
    - Cover the whole surface, including folders outside the "obvious scene subset"
      that are easy to forget (collisions, culling/bounding, gizmos, behaviors,
      actions, sprites, particles, physics, layers, morph, post-processes, and the
      loader plugins under `loaders/src`).

3. **Build the coverage ledger.** For each enumerated symbol, confirm it maps to a
   row in `COMPAT-STATUS.md`. Produce a list of **uncovered symbols** (exported by
   core/loaders but absent from the matrix). This list is the audit's primary
   output and must be empty before you finish.

4. **Triage every uncovered symbol** — and **re-triage every existing `❌` / `🔧`
   row** — against the *current* Babylon Lite public API. Do not trust the prior
   status; the whole point is to catch things Lite can now back. For each:
    - Search Lite's surface for a backing capability before concluding it is
      unsupported: read `packages/babylon-lite/src/index.ts` and grep
      `packages/babylon-lite/src/**` for related names (e.g. searching `pick`
      would have surfaced `createGpuPicker` / `pickAsync`).
    - If Lite can back it → implement the wrapper (see "Implementation patterns").
    - If Lite *almost* backs it but the clean surface is missing, consider adding a
      **tree-shakeable** accessor/function to Lite core (imported only by compat —
      see "Implementation patterns"). Only do this if you can prove zero bundle-size
      impact; otherwise record `🔧 Needs Lite core`.
    - If Lite cannot back it but BJS exposes the symbol → add a **throwing stub**
      via the `unsupported()` helper (standalone class in
      `src/unsupported/unsupported-apis.ts`, or a throwing method on the relevant
      wrapper) and a matrix row. A user must never get a bare "not exported" error
      for a real core/loaders symbol.
    - If it is genuinely out of scope per the Scope section → ignore it (no row).

---

## Phase B — Incremental diff (prioritisation)

1. **Find the last Lite change since the previous sync.** Run:
    ```
    git log -1 --format=%H -- packages/babylon-lite-compat/COMPAT-STATUS.md
    ```
    Call this `LAST_STATUS_COMMIT`. Lite changes to consider are everything in
    `packages/babylon-lite/src/**` since `LAST_STATUS_COMMIT`:
    ```
    git log --oneline LAST_STATUS_COMMIT..HEAD -- packages/babylon-lite/src
    git diff --stat LAST_STATUS_COMMIT..HEAD -- packages/babylon-lite/src/index.ts
    ```
    New public exports in `index.ts` are new Lite capabilities — cross-reference
    them against the `🔧 Needs Lite core` / `⚡ Partial` / `❌` rows from Phase A,
    since they may now be upgradable.
2. **Find what changed in Babylon.js core/loaders since `LAST_BJS_SHA`.**
    - Latest master HEAD: `https://api.github.com/repos/BabylonJS/Babylon.js/commits/master`
      (record the new SHA as `NEW_BJS_SHA`).
    - Compare view: `https://api.github.com/repos/BabylonJS/Babylon.js/compare/LAST_BJS_SHA...master`
      — act only on changes under `packages/dev/core/src/**` and
      `packages/dev/loaders/src/**`. New symbols here must already have been caught
      by Phase A's enumeration; the diff just tells you which ones are *new* so you
      prioritise them.

---

## Implementation patterns

When Phase A/B determines a symbol is now implementable on Lite, build the wrapper
following the existing patterns in `packages/babylon-lite-compat/src/`:

- **Match Babylon.js type names and public shapes exactly — this is the whole point
  of the compat layer.** The goal is that ported code that imports from
  `@babylonjs/core` / `@babylonjs/loaders` works unchanged against the compat
  barrel, so every exported class, interface, enum, and type alias MUST use the
  **same name** as Babylon.js, and every public property/method/getter MUST match
  Babylon.js's name, return type, and (where observable) behaviour. **Never invent a
  divergent name** (e.g. exposing `scene.animationGroups` as a `LoadedAnimationGroup`
  instead of `AnimationGroup`, or returning a bespoke `MyMeshWrapper` instead of
  `Mesh`). Babylon.js has exactly one `AnimationGroup` / `Mesh` / `Texture` type;
  the compat layer must too. If two internal construction paths need different
  backing (e.g. a structurally-built group vs. one wrapping a Lite loaded group),
  reconcile them into the **single** BJS-named class (an `@internal` factory such as
  `AnimationGroup._fromLite(...)` is fine) — do not expose a second public type.
  A divergent type name is an API-parity bug even if the methods happen to work.
- Plain class wrappers that hold the Lite object as `_lite` (or `_node`). Mark the
  handle property with an `@internal` JSDoc tag (the repo's
  `babylon-lite/underscore-requires-internal` lint rule requires it).
- **Mirror the BJS class hierarchy.** Reproduce the full inheritance chain from the
  `.d.ts` (e.g. `Mesh extends AbstractMesh extends TransformNode extends Node`),
  even when intermediate classes are only partially implemented, so `instanceof`
  checks and inherited members behave as ported code expects. Define each member on
  the same ancestor BJS defines it on (e.g. `getScene()` on `Node`), not flattened
  onto the leaf class.
- Property getters/setters that proxy to the Lite object; mutating a material
  property must call `markMaterialUboDirty`.
- Constructors that take the BJS argument order and auto-register with the scene
  (`addToScene` / set `activeCamera`) when a scene is passed.
- Never install a `BABYLON` global or any module-level side effect.
- Export the new symbol from `src/index.ts`.
- For anything still impossible on the Lite API, ship a **throwing stub** via
  `unsupported(...)` rather than omitting the symbol — do **not** fake behaviour.

Per change category:

- **Newly implementable (Lite gained the capability):** upgrade a `🔧 Needs Lite core`
  / `⚡ Partial` / `❌` row to a real wrapper.
- **New BJS surface within an existing covered class:** add the missing
  properties/methods if Lite supports them; otherwise add a throwing stub and mark
  the row `⚡ Partial`.
- **New BJS symbol with no Lite equivalent:** add a throwing stub (so the import
  resolves and fails loudly) and a `❌ Not supported` row.

Keep changes scoped to the compat package **whenever possible**. You **may** add
new functionality to `packages/babylon-lite/` core to support compat, but **only
when the addition is 100% tree-shakeable — i.e. zero impact on existing Lite
bundle sizes.** In practice this means:

- Add a **new, separately-exported** function/symbol that **nothing in Lite's own
  scenes, demos, or other modules imports** — only the compat layer imports it. A
  brand-new export that no existing bundle references is dropped by tree-shaking
  from every existing bundle, so it cannot change any ceiling.
- Do **not** modify, wrap, or add code to an existing Lite function, class, hot
  path, or module that is already pulled into scene bundles — that risks changing
  bundle sizes and is not allowed here.
- Prefer reading Lite's existing **public** fields from the compat wrapper over
  reaching into `_`-prefixed internals. If the clean surface is missing, a new
  tree-shakeable accessor in Lite (imported only by compat) is the preferred fix.

**You must prove the zero-impact claim before finishing**: build the scene bundles
and confirm the bundle-size manifest is unchanged versus the committed baseline:

```
pnpm build:bundle-scenes
git diff --stat -- lab/public/bundle/manifest.json   # must be empty
```

If the manifest diff is non-empty, the Lite addition is **not** tree-shakeable —
revert it and record the gap as `🔧 Needs Lite core` instead. When a needed Lite
addition cannot be made tree-shakeable, do **not** force it; record `🔧 Needs Lite
core` and stop there.

---

## Test coverage (required)

For every wrapper you add or extend, add or update a test in
`packages/babylon-lite-compat/tests/`:

- Prefer **GPU-free unit tests**. The compat unit tests run under Node with no
  WebGPU device, so test the pure-logic surface: math, observables, easing,
  the assets-manager scheduler, property get/set proxying against a fake/minimal
  Lite object, enum mappings, and error-throwing stubs.
- Do **not** write tests that require a real GPU device or a live `createEngine`
  — those belong to the Lite parity/perf suites, not here.

Run the suite and the typecheck before finishing:

```
npx vitest run --project compat
npx tsc -p packages/babylon-lite-compat/tsconfig.json --noEmit
npx tsc -p packages/babylon-lite-compat/tests/tsconfig.json --noEmit
npx eslint packages/babylon-lite-compat
npx prettier --check "packages/babylon-lite-compat/**/*.ts"
```

All must pass.

**If (and only if) you added anything to `packages/babylon-lite/` core this run,**
also prove it is tree-shakeable with a clean A/B build — the committed manifest can
be stale, so compare two fresh builds that differ *only* by your Lite change:

```
# 1. Build WITH your change, save the manifest
pnpm build:bundle-scenes
copy lab/public/bundle/manifest.json with.json
# 2. Revert ONLY your Lite-core files, rebuild, save the baseline
git stash push -- packages/babylon-lite/src/<your-files>
pnpm build:bundle-scenes
copy lab/public/bundle/manifest.json base.json
git stash pop
# 3. The two manifests must be byte-identical (per-scene rawKB/gzipKB unchanged)
```

If any scene's size differs between the two builds, the Lite addition is **not**
tree-shakeable — revert it and record `🔧 Needs Lite core` instead.

---

## Completeness gate (required before finishing)

Do not finish until the coverage ledger from Phase A is **empty**:

- [ ] Every public symbol exported by `@babylonjs/core` and `@babylonjs/loaders`
      maps to a row in `COMPAT-STATUS.md` (as `✅` / `⚡` / `🔧` / `❌`).
- [ ] No core/loaders symbol resolves to a bare "not exported" error — every one is
      either wrapped or shipped as a throwing `unsupported(...)` stub.
- [ ] Every existing `❌` / `🔧` row was re-checked against the *current* Lite API
      this run (not assumed from the previous sync).
- [ ] Tests, both typechecks, ESLint, and Prettier all pass.

If any box is unchecked, the run is not done.

---

## Update `COMPAT-STATUS.md` (required, last step)

After implementing and testing:

1. Update every feature row you changed to its new status.
2. Add rows for any newly enumerated BJS core/loaders symbols (even unsupported ones).
3. Set `Last synced BJS commit` to `NEW_BJS_SHA`.
4. Set `Last sync date` to today's date.
5. If the compat package version changed, update `Lite compat package version`.

---

## Guardrails

- **Exact Babylon.js API parity — same type names, same public shapes.** Exported
  symbols must carry the identical name Babylon.js uses (`AnimationGroup`, not
  `LoadedAnimationGroup`; `Mesh`, not `MeshWrapper`) and expose the same public
  member names/return types. Ported `@babylonjs/core`/`@babylonjs/loaders` code must
  be able to run against the compat barrel without renaming a single import or
  member. A divergent public name is a parity bug — collapse alternate backings into
  the one BJS-named type via an `@internal` factory.
- The compat package is **opt-in and excluded from Lite bundle-size ceilings** —
  but it must remain free of module-level side effects so it never bloats a
  consumer that doesn't import it.
- Any Lite-core addition made to support compat **must be 100% tree-shakeable
  (zero bundle-size impact)** and proven so via `pnpm build:bundle-scenes` +
  `git diff --stat -- lab/public/bundle/manifest.json` (empty diff). Never modify
  an existing Lite function/module that scene bundles already pull in.
- Do not run `pnpm test:perf` or the Lite parity suite; they are unrelated to
  compat work.
- Keep the wrappers honest: a feature is only `✅ Full`/`⚡ Partial` if it actually
  works on the Lite API. When in doubt, mark it `🔧`/`❌` and explain in the row.
- Summarise at the end: the size of the Phase A coverage ledger (and that it is now
  empty), which BJS/Lite changes you acted on, which wrappers were added/extended,
  any tree-shakeable Lite-core additions (with the bundle-diff proof), the new
  `NEW_BJS_SHA`, and the test/typecheck/lint results.
