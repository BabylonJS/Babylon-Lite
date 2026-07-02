# Update the Babylon Lite Compat Layer

You maintain `@babylonjs/lite-compat` — the Babylon.js-shaped compatibility layer
over the Babylon Lite public API (package `packages/babylon-lite-compat/`). Each run
**reacts to change**: pick up everything that changed upstream since the last sync
(Task 1), advance lab-scene coverage when a Lite change unblocks it (Task 2,
conditional), and close API-parity gaps (Task 3) — adding tests and updating the
status file throughout.

**Cardinal rule — compat is a pure API layer; feature logic lives in Lite, never in
compat.** The compat package may contain only adapter/translation code (name mapping,
argument reordering, type wrapping, forwarding to Lite). It must **never** implement a
feature itself — no rendering math, algorithms, or simulation/loader/material
behaviour. For every wrapper, the real work must be done by Lite. When a BJS symbol
needs behaviour Lite doesn't expose, you have exactly three moves — never a fourth
where the feature lives in compat:

1. **Wrap existing Lite behaviour** — translate the BJS call into the equivalent Lite
   call(s). Preferred whenever Lite already does it.
2. **Add the capability to Lite, then wrap it** — it is fine to add new functionality
   (even a genuinely new feature) to `packages/babylon-lite/`, **provided it is 100%
   tree-shakeable** (zero impact on existing scene bundle sizes). The feature lives in
   Lite; compat just wraps it.
3. **Otherwise throw** — if the capability can't be added to Lite within the
   tree-shakeability constraint, ship a throwing `unsupported(...)` stub and record a
   `🔧`/`❌` row.

A wrapper that does feature work itself is a **defect**, even if its tests pass.

**Be comprehensive, not minimal.** Address the _entire_ delta and _all_ newly-possible
gaps each run, not a cherry-picked item. The "land at least one" phrasing below is a
hard floor for forward progress, never the target; leave an item only if it is
genuinely blocked (record why).

The single source of truth for all three is
`packages/babylon-lite-compat/COMPAT-STATUS.md`, which tracks them in three places:

| Task | Goal                             | Tracked in `COMPAT-STATUS.md` by                                  |
| ---- | -------------------------------- | ----------------------------------------------------------------- |
| 1    | Upstream diffs                   | the `Last synced BJS commit` + `Last sync date` markers           |
| 2    | Lab-scene coverage (conditional) | the **Lab scene coverage** section (working list + blocker table) |
| 3    | API parity                       | the per-area **status matrix** (a row per core/loaders symbol)    |

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

## The three tasks (read this first)

- **Task 1 — React to upstream diffs.** Act on **everything** that changed in BJS
  core/loaders and Babylon Lite since the last sync.
- **Task 2 — Advance lab-scene coverage (conditional).** Only when a Task 1 Lite
  change makes a previously-skipped scene possible, drive that scene to pixel parity
  (MAD ≈ 0). If nothing new unblocks a scene, Task 2 has no deliverable — don't force
  a scene blocked for a reason that still holds.
- **Task 3 — Close API-parity gaps.** Bring the compat surface toward the full
  `@babylonjs/core` + `@babylonjs/loaders` public API. Be comprehensive: implement
  every gap the current Lite API can back, not just one.

Task 3 carries a hard **completeness invariant** — every core/loaders symbol must have
a status row. The tasks feed each other: a Task 1 diff can unblock a Task 2 scene or a
Task 3 gap, and a scene's native Lite port is often the fastest recipe for proving a
Task 3 gap implementable.

---

## Task 1 — React to upstream BJS/Lite diffs

1. **Find Lite changes since the previous sync.** Get `LAST_STATUS_COMMIT`, then
   review Lite source changes since it:
    ```
    git log -1 --format=%H -- packages/babylon-lite-compat/COMPAT-STATUS.md
    git log --oneline LAST_STATUS_COMMIT..HEAD -- packages/babylon-lite/src
    git diff --stat LAST_STATUS_COMMIT..HEAD -- packages/babylon-lite/src/index.ts
    ```
    New public exports in `index.ts` are new Lite capabilities — cross-reference them
    against `🔧`/`⚡`/`❌` rows (they may now be upgradable). **This is the Task 2
    trigger:** if a new Lite capability clears a blocker on a previously-skipped lab
    scene, drive that scene to parity. If no new Lite capability lands, Task 2 stays
    dormant.
2. **Find BJS core/loaders changes since `LAST_BJS_SHA`** (the `Last synced BJS
commit` in `COMPAT-STATUS.md`): - Latest master HEAD → `https://api.github.com/repos/BabylonJS/Babylon.js/commits/master`
   (record as `NEW_BJS_SHA`). - Compare → `https://api.github.com/repos/BabylonJS/Babylon.js/compare/LAST_BJS_SHA...master`
   — act only on `packages/dev/core/src/**` and `packages/dev/loaders/src/**`. New
   symbols feed Task 3's ledger; the diff just flags which are _new_ to prioritise.

---

## Task 2 — Advance lab-scene coverage (conditional)

The lab renders each BJS oracle scene (`lab/lite/src/bjs/sceneN.ts`) through compat at
`/compat/sceneN.html`. A scene **works** when its compat render matches the native
Lite port (`/lite/sceneN.html`) at MAD ≈ 0. The **Lab scene coverage** section of
`COMPAT-STATUS.md` is the live record (working list + count, plus a blocker table).

**This task only fires when a Task 1 Lite change makes a previously-skipped scene
possible.** Otherwise a blocked scene is still blocked for the same reason — leave its
blocker row as the accurate record and move on. When a Lite change does unblock a
scene, drive it all the way to parity:

1. Identify the new Lite capability and check the blocker table — does it clear a
   not-working scene's blocker? If not, Task 2 is done for this run (record that).
2. **If a scene is unblocked, see it through.** Open `/compat/sceneN.html`, read the
   console error, fix/stub that gap, re-run, read the next error. A scene may fail on
   a **chain** of blockers; it only counts once the whole chain clears, the canvas
   renders, and `dataset.ready` is set.
3. For each gap, read both the BJS oracle and the native Lite port
   (`lab/lite/src/lite/sceneN.ts`). **If the Lite port renders the feature, Lite can
   back it** — that port is a copy-able recipe for the exact Lite call sequence to
   wrap.
4. Measure parity (in-browser MAD diff of `/compat/sceneN` vs `/lite/sceneN`; use
   `?freeze=1` / `?seekTime=0` for animated scenes). Drive to MAD ≈ 0. If it renders
   but diverges, 3-way compare against `babylon-ref-golden.png` to localise the gap.
5. At MAD ≈ 0, set `"compatParity": true` in `scene-config.json`, regression-check a
   sample of already-working scenes, then update the **Lab scene coverage** section
   (move the scene into the working list, bump the count, update/remove the blocker).

---

## Task 3 — Close API-parity gaps (coverage audit, full enumeration)

**Every public symbol exported from BJS core + loaders MUST have a row in
`COMPAT-STATUS.md`** — a symbol with no row is an undetected gap. The Task 1 diffs
only surface what _changed_, so every run does a **full enumeration** of the
core/loaders export surface and reconciles it against the matrix. That enumeration is
the mandatory completeness gate; implementing the gaps it surfaces is incremental.

**Required outcome.** Address every gap the current Lite API can back this run (the
comprehensive target). The hard **floor** a run must never drop beneath is at least
one of: (a) add a missing API — even a throwing stub — so a symbol that bare-failed
now resolves; (b) upgrade a stub/`⚡ Partial` to a real Lite-backed implementation; or
(c) prove, via the exhaustive re-triage in step 4, that every symbol has a row and no
`❌`/`🔧` can currently be upgraded (the only outcome needing no code change). A run
that hits only the floor while other implementable gaps remain is **incomplete**.

1. **Read `COMPAT-STATUS.md`** and extract `LAST_BJS_SHA` and `Last sync date`.
2. **Enumerate the full BJS core + loaders public API surface** using the published
   **`.d.ts`** declarations as the authoritative shape (every exported symbol, the
   full inheritance chain, each class's members). Read from the built declarations
   (repo `dist`, or the npm tarballs of `@babylonjs/core` / `@babylonjs/loaders`),
   starting at each `index.d.ts` and following re-exports; fall back to the source
   `index.ts` barrels on GitHub raw `master` if a `.d.ts` is unavailable. Capture
   every top-level symbol and its base class, and cover easily-forgotten folders
   (collisions, culling/bounding, gizmos, behaviors, actions, sprites, particles,
   physics, layers, morph, post-processes, loader plugins under `loaders/src`).
3. **Build the coverage ledger.** List **uncovered symbols** (exported by
   core/loaders but absent from the matrix). This is the audit's primary output and
   must be empty before you finish.
4. **Triage every uncovered symbol — and re-triage every existing `❌`/`🔧` row —
   against the _current_ Lite API** (don't trust prior status). For each:
    - Search Lite first: read `packages/babylon-lite/src/index.ts` and grep
      `packages/babylon-lite/src/**` for related names (e.g. `pick` surfaces
      `createGpuPicker` / `pickAsync`). **Also check for a native Lite lab scene**
      (`lab/lite/src/lite/sceneN.ts`) — if its port renders the feature, Lite **can**
      back it (the port is a copy-able recipe); "no compat wrapper yet" ≠ "Lite can't
      do it". Driving such a scene to parity is Task 2 (only if newly unblocked).
    - Apply the three moves from the Cardinal rule: **wrap** if Lite backs it; **add
      a tree-shakeable capability to Lite then wrap** if it doesn't but can (including
      exposing an existing internal via a compat-only accessor); else **throw** an
      `unsupported(...)` stub (standalone class in
      `src/unsupported/unsupported-apis.ts`, or a throwing method) plus a matrix row —
      never a bare "not exported" error, and never feature logic in compat.
    - If genuinely out of scope per the Scope section → ignore it (no row).

---

## Implementation patterns

When Task 2 or Task 3 surfaces a symbol to support, build the wrapper following the
existing patterns in `packages/babylon-lite-compat/src/`. The wrapper only translates
names/shapes and forwards to the Lite API — the feature logic lives in Lite (existing
or newly added there), **never in the compat package**:

- **Match Babylon.js type names and public shapes exactly** — ported code importing
  from `@babylonjs/core` / `@babylonjs/loaders` must work unchanged against the compat
  barrel, so every exported class/interface/enum/type alias uses the **same name** as
  BJS, and every public member matches BJS's name, return type, and observable
  behaviour. **Never invent a divergent name** (no `LoadedAnimationGroup` for
  `AnimationGroup`, no `MyMeshWrapper` for `Mesh`). If two internal construction paths
  need different backing, reconcile them into the **single** BJS-named class via an
  `@internal` factory (e.g. `AnimationGroup._fromLite(...)`) — never a second public
  type. A divergent name is an API-parity bug even if the methods work.
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

**Adding the capability to Lite (move 2 from the Cardinal rule)** must be 100%
tree-shakeable so existing bundles are untouched:

- Add **new, separately-exported** symbol(s) to Lite that **nothing in Lite's own
  scenes, demos, or other modules imports** — only compat imports them. A brand-new
  export no existing bundle references is dropped by tree-shaking, so it can't change
  any ceiling — true whether it merely exposes an existing internal via a clean getter
  or implements a new feature outright.
- Do **not** modify or add code to an existing Lite function/class/module already
  pulled into scene bundles; new functionality goes into new, independently-importable
  paths.
- Prefer reading Lite's **public** fields over `_`-prefixed internals; if the clean
  surface is missing, a new compat-only tree-shakeable export is the fix.

Prove zero impact before finishing (see "Test coverage" for the rigorous A/B build).
If any scene's size moves, the addition isn't tree-shakeable — revert it and record
`🔧 Needs Lite core`.

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
pnpm exec vitest run --project compat
pnpm exec tsc -p packages/babylon-lite-compat/tsconfig.json --noEmit
pnpm exec tsc -p packages/babylon-lite-compat/tests/tsconfig.json --noEmit
pnpm exec eslint packages/babylon-lite-compat
pnpm exec prettier --check "packages/babylon-lite-compat/**/*.ts"
```

All must pass.

**If (and only if) you added anything to `packages/babylon-lite/` core this run,**
also prove it is tree-shakeable with a clean A/B build — the committed manifest can
be stale, so compare two fresh builds that differ _only_ by your Lite change:

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

Task 3's coverage ledger is the hard gate every run; Task 2 only gates a run where a
Lite change unblocked a scene. Do not finish until:

- [ ] **(Task 2)** If a Lite change this run unblocked a scene, at least one such
      scene renders at MAD ≈ 0, has `"compatParity": true` in `scene-config.json`, and
      is in the **Lab scene coverage** working list (count bumped). If nothing was
      unblocked, recording that satisfies this box.
- [ ] **(Task 3)** The full set of implementable gaps was addressed (not just one);
      remaining `❌`/`🔧` rows were all re-checked this run and confirmed un-backable.
      State which floor outcome you hit (added API / upgraded stub / proof of
      completeness) and confirm nothing implementable was left.
- [ ] **(Task 3)** Every `@babylonjs/core` + `@babylonjs/loaders` symbol maps to a row
      (`✅`/`⚡`/`🔧`/`❌`) — ledger empty — and none resolves to a bare "not exported"
      error (each is wrapped or a throwing stub).
- [ ] **(Task 3)** The **Supported APIs at a glance** table in
      `packages/babylon-lite-compat/README.md` still reflects the matrix (any changed
      area's roll-up + note updated).
- [ ] **(Task 1)** `Last synced BJS commit` / `Last sync date` updated to
      `NEW_BJS_SHA` / today.
- [ ] Tests, both typechecks, ESLint, and Prettier all pass.

If any box is unchecked, the run is not done.

---

## Update `COMPAT-STATUS.md` (required, last step)

Update the part each task touched:

1. **(Task 3)** Update changed feature rows and add rows for any newly enumerated
   core/loaders symbols (even unsupported ones).
2. **(Task 2, only if a scene was unblocked)** Update the **Lab scene coverage**
   section — move newly-working scenes into the working list (bump the count) and
   revise/remove blocker rows.
3. **(Task 1)** Set `Last synced BJS commit` to `NEW_BJS_SHA` and `Last sync date` to
   today; update `Lite compat package version` if it changed.

Then **sync the README summary** (`packages/babylon-lite-compat/README.md`,
**Supported APIs at a glance**): a per-_feature-area_ roll-up (one `✅`/`⚡`/`❌` per
area; `🔧` rolls up to the more user-visible of `⚡`/`❌`). Update any area whose
roll-up or one-line note this run made inaccurate. It's a summary — not per-symbol —
and ships to npm, so add no per-symbol rows and no internal-doc links.

---

## Guardrails

- **Cardinal rule (restated):** compat is a pure API layer — feature logic lives in
  Lite, never in compat. A wrapper that does feature work itself is a defect even if
  its tests pass. Any Lite addition to support compat must be 100% tree-shakeable.
- **Exact API parity:** exported symbols carry the identical BJS name and public
  member shapes, so ported code runs against the compat barrel without renaming a
  single import or member. A divergent public name is a parity bug.
- The compat package is **opt-in and excluded from Lite bundle-size ceilings**, but
  must stay free of module-level side effects so it never bloats a non-importing
  consumer.
- Do not run `pnpm test:perf` or the Lite parity suite; they are unrelated to compat
  work.
- Keep wrappers honest: a feature is `✅ Full`/`⚡ Partial` only if it actually works
  by delegating to Lite. When in doubt, mark `🔧`/`❌` and throw.
- **When Task 2 fires, land the scene — don't just unblock it:** drive it to MAD ≈ 0
  and into the working list (expect a chain of several gaps). If nothing was
  unblocked, zero scene work is correct.
- Summarise at the end, per task: **(Task 1)** changes acted on + `NEW_BJS_SHA`;
  **(Task 2)** which scene(s) landed at MAD ≈ 0 + new count (or "none unblocked");
  **(Task 3)** which floor outcome you hit, the (now-empty) ledger size, any
  tree-shakeable Lite additions with bundle-diff proof, and the test/lint results.

---

## Hand-off to the pipeline — PR title (required when you changed anything)

The pipeline (`scripts/open-compat-sync-pr.ts`) opens the draft PR; you do **not**.
It cannot infer a meaningful title from your diff, so the title is generic unless
you provide one. As your **final step on any run that changed files**, write a
single concise, descriptive line summarising the specific work this run to:

```
.compat-sync-pr-title.txt   (repo root)
```

- Keep it **≤ ~70 characters** and specific to what changed — e.g.
  `Wrap AnimationGroup blending + add 3 loader stubs` or
  `Implement MorphTargetManager API; sync to BJS abc1234`. Never reuse a generic
  catch-all like "compat-layer sync".
- Write the **bare summary only** — do **not** add a `[compat-sync]` prefix or any
  other prefix. The pipeline prepends `[compat-sync]` deterministically; anything you
  add would be stripped or duplicated.
- The pipeline reads this file, then **deletes it before committing**, so it is a
  scratch artifact and never lands in the PR. (It is git-ignored as a safeguard.)
- If the run changed nothing, do **not** create the file — the pipeline falls back
  to the generic title and (with no diff) opens no PR anyway.
