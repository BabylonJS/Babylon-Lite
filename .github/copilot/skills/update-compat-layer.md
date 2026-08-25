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
2. **Add the capability to Lite, then wrap it** — it is fine, and **expected**, to add
   new functionality to `packages/babylon-lite/`, **provided it is 100% tree-shakeable**
   (zero impact on existing scene bundle sizes) **and the addition is small, contained,
   and objective**. The feature lives in Lite; compat just wraps it. This is the
   **normal** answer whenever Lite doesn't already do it — a routine part of the run,
   not a last resort or an escalation.
3. **Otherwise throw** — when the capability cannot be added to Lite within the
   tree-shakeability constraint, or the addition would be large/subjective (see below).
   Ship a throwing `unsupported(...)` stub and record a `🔧`/`❌` row.

A wrapper that does feature work itself is a **defect**, even if its tests pass.

**"Lite doesn't have it today" is never a reason to throw** — it is precisely the
trigger for move 2. Move 3 needs a _structural_ blocker, and you must be able to name
it. A purely additive, tree-shakeable Lite addition costs an existing consumer nothing,
so the bar for making one is low; the bar for declining to is high.

**But move 2 is only for _mechanical_ additions.** You are extending someone else's
engine unattended, so add only what has an obvious, uncontroversial implementation:

- **Small and contained** — on the order of one or two functions in one module, using
  Lite's existing primitives. No new subsystem, no new concept in Lite's model, no
  change to an existing signature or behaviour.
- **Objective** — a competent engine author would write essentially the same thing.
  Good signs: an exact BJS/WebGPU semantic to mirror, or an existing Lite sibling to
  copy one dimension across (`createTexture3DFromPixels` → `createTexture2DArrayFromPixels`).
- **No open design questions** — if you find yourself choosing a caching strategy, a
  scheduling/lifetime policy, a new public shape with no precedent, or picking between
  several defensible architectures, **stop**. That is a design decision for the Lite
  maintainers, not for this run.

If it fails any of these, take move 3 and record `🔧 Needs Lite core` with a one-line
sketch of the design question — that row is the ask, and a human resolves it.

### Choosing your move (work this before writing any `unsupported(...)`)

Stop at the first hit; record the outcome in your run summary.

1. **Does Lite already do it?** Grep `packages/babylon-lite/src/index.ts` and the source
   tree for related verbs/nouns, and check the native lab port
   (`lab/lite/src/lite/sceneN.ts`) — if the port renders it, Lite backs it. → **move 1**.
2. **Does compat already wrap a sibling of the same shape?** Find the analogous BJS
   symbol already wrapped here (e.g. `RawTexture3D` for `RawTexture2DArray`, `Texture`
   for `DynamicTexture`, `Mesh` for a new mesh variant) and read what Lite call it
   forwards to. A working sibling **proves the shape is backable** and usually names the
   exact Lite function — or its one-dimension-different twin — to reuse. → **move 1**,
   or **move 2** for the variant.
3. **Is the blocker inside compat rather than Lite?** If Lite can do the work but compat
   has no way to _reach_ it — a missing accessor, no handle to pass through, an absent
   `@internal` factory, a BJS helper that needs the internal texture/mesh/buffer — that
   is a **compat plumbing gap you must fix**, not a Lite limitation. Add the accessor.
   → **move 1**.
4. **Can a small, mechanical, brand-new Lite export back it?** If it is real engine/GPU
   behaviour Lite doesn't expose, and it clears the small/contained/objective bar above,
   add it as a new independently-importable export (see "Adding the capability to
   Lite"). → **move 2**.
5. **Only if none of the above** → **move 3**. A valid structural blocker is concrete:
   the code would have to live in a module existing scene bundles already pull in; it
   needs engine state Lite deliberately doesn't expose; it depends on an out-of-scope
   package; an A/B build showed a real size delta; or the Lite work would be large or
   design-subjective. Write that reason in the stub's code comment **and** the
   `COMPAT-STATUS.md` row. "No Lite equivalent exists", "Lite's API uploads X, not Y",
   or "would need new Lite core work" are **not** valid reasons — they are restatements
   of move 2's precondition.

**Be comprehensive, not minimal.** Address the _entire_ delta and _all_ newly-possible
gaps each run, not a cherry-picked item. The "land at least one" phrasing below is a
hard floor for forward progress, never the target; leave an item only if it is
genuinely blocked (record why).

The single source of truth for all three is
`packages/babylon-lite-compat/COMPAT-STATUS.md`, which tracks them in three places:

| Task | Goal                             | Tracked in `COMPAT-STATUS.md` by                                  |
| ---- | -------------------------------- | ----------------------------------------------------------------- |
| 1    | Upstream diffs                   | the two `Last synced ...` SHAs + the `Last sync date` marker      |
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

1. **Find Lite changes since the previous sync.** Read `LAST_LITE_SHA` from the
   `Last synced Lite commit` marker in `COMPAT-STATUS.md`, and record the Lite
   `master` HEAD you are syncing against as `NEW_LITE_SHA`. Capture `NEW_LITE_SHA`
   **before you commit anything**, or it will point at your own work:

    ```
    git rev-parse origin/master                 # -> NEW_LITE_SHA
    git log --oneline LAST_LITE_SHA..NEW_LITE_SHA -- packages/babylon-lite/src
    git diff --stat LAST_LITE_SHA..NEW_LITE_SHA -- packages/babylon-lite/src/index.ts
    ```

    New public exports in `index.ts` are new Lite capabilities — cross-reference them
    against `🔧`/`⚡`/`❌` rows (they may now be upgradable). **This is the Task 2
    trigger:** if a new Lite capability clears a blocker on a previously-skipped lab
    scene, drive that scene to parity. If no new Lite capability lands, Task 2 stays
    dormant.

    Do **not** derive this watermark from the history of `COMPAT-STATUS.md` itself.
    It is recorded as a marker _inside_ that file precisely so that editing the file
    is harmless — a status-row correction must never move the watermark.

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
    - **Then search compat for a sibling of the same shape** — the analogous BJS symbol
      already wrapped here, and what Lite call it forwards to. A Lite-backed sibling is
      the strongest available evidence that this symbol is backable too.
    - Work the **"Choosing your move"** procedure from the Cardinal rule in order:
      **wrap** if Lite backs it; **fix the compat plumbing** if the only thing missing
      is a way to reach Lite; **add a tree-shakeable capability to Lite then wrap** if
      Lite genuinely lacks it (including exposing an existing internal via a
      compat-only accessor); else **throw** an `unsupported(...)` stub (standalone class
      in `src/unsupported/unsupported-apis.ts`, or a throwing method) plus a matrix row
      — never a bare "not exported" error, and never feature logic in compat. Every
      stub must carry a named structural reason.
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
- **Confirm every public name against a real BJS source before you write it — always,
  not just when you feel unsure.** A wrong name is a _confident_ error, so discretionary
  "grep if in doubt" advice never fires; make the check unconditional for every exported
  symbol and, above all, for every **method, property or accessor** hanging off an
  otherwise correctly-named class. And **never name a member after the Lite function it
  forwards to** — that is how `Bone.resetToRest()` shipped: it forwards to Lite's
  `clearBoneOverride`, which reads as "reset to rest", while BJS declares only
  `returnToRest()` — a name already checked into this repo at
  `lab/lite/src/bjs/scene99.ts`. The Lite call is the implementation; BJS is the name.
    ```
    # 1. BJS oracle scenes — always checked in, no install needed
    git grep -nw "<memberName>" -- lab/lite/src/bjs
    # 2. installed typings — exhaustive, but gitignored and often absent
    grep -Rnw "<memberName>" lab/node_modules/@babylonjs/core
    ```
    Keep `-w` in both — whole-word matching stops a near-miss like `returnToRes`
    counting as a hit on `returnToRest`, and avoids `\b`, which is not portable across
    grep implementations. Then read the two results asymmetrically. The oracle scenes
    are hundreds of real `@babylonjs/core` programs, so a hit **proves the name is
    real** — but they are a sample, so a miss proves nothing. The typings are
    exhaustive, so zero hits there **proves the name invented** (open the owning class's
    `.d.ts` and copy the real one verbatim; add `@babylonjs/loaders` for loader
    symbols). If the typings aren't installed, the name is **unverified — never
    "invented"**: keep looking, and never ship a name no source confirmed.
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
tree-shakeable so existing bundles are untouched, and small/contained/objective per the
Cardinal rule. Done this way it is cheap, routine, and provably zero-risk:

- Add **new, separately-exported** symbol(s) to Lite that **nothing in Lite's own
  scenes, demos, or other modules imports** — only compat imports them. A brand-new
  export no existing bundle references is dropped by tree-shaking, so it can't change
  any ceiling — true whether it merely exposes an existing internal via a clean getter
  or implements a new feature outright.
- **Cheap up-front proof (do this before writing the code, to pick your move).** A
  module is safe to extend if nothing that lands in a scene bundle imports it. List its
  importers:
    ```
    git grep -l "<module-file>.js" -- packages/babylon-lite/src lab/lite/src playground
    ```
    The Lite barrel `packages/babylon-lite/src/index.ts` always appears and doesn't
    count (re-exports are tree-shaken). **Any other hit** — a scene, a demo, or another
    Lite module — means the file is already in bundles: put your addition in a **new**
    file instead. No other hits means the addition **cannot** move a bundle, so move 2
    is available. Confirm with the bundle build at the end of the run, but decide here;
    don't defer the decision to the build.
- **Purely additive only.** Do **not** modify or add code to an existing Lite
  function/class/module already pulled into scene bundles; new functionality goes into
  new, independently-importable paths. Because the addition is additive and unreferenced
  by existing code paths, it cannot change rendering — no Lite parity run is required
  (and per the Guardrails you must not run one). If you find yourself needing to change
  an existing hot path, that is a genuine structural blocker → move 3.
- Prefer reading Lite's **public** fields over `_`-prefixed internals; if the clean
  surface is missing, a new compat-only tree-shakeable export is the fix.
- **Match BJS defaults when forwarding.** Lite and BJS often pick different defaults for
  the same optional argument (e.g. BJS `invertY = false` vs Lite `invertY = true`).
  Never let a forwarded call fall through to Lite's default — read both signatures and
  pass the BJS value explicitly, or thread an option through so you can. A silent
  default mismatch is an API-parity bug that no throwing-stub test will catch.

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
- **Never assert `.toThrow()` on a surface that moves 1–4 could back.** A green
  `expect(...).toThrow(LiteCompatError)` test on a backable API cements the defect and
  makes the run _look_ validated — it is worse than no test. Only assert throwing for a
  stub you justified with a named structural blocker; if you later implement the
  surface, delete the throw assertion rather than leaving both.
- For a Lite-backed wrapper, test the **forwarding contract**: mock the Lite function
  and assert it was called with the translated arguments — including the **BJS default
  values** for optional parameters you didn't pass. Where a BJS helper hops through the
  engine, exercise the real hop (e.g. borrow `AbstractEngine.prototype.<method>` in the
  fake scene) so the whole chain is covered rather than the top of it.

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
prove it is tree-shakeable with a bundle build. The tracked baseline is the **per-scene**
manifest set `lab/public/bundle/manifest/<scene>.json` (the aggregate
`lab/public/bundle/manifest.json` is generated and git-ignored — don't diff that).

```
# 1. Build WITH your change (~15 min), then ask git whether any scene moved
pnpm build:bundle-scenes
git status --porcelain lab/public/bundle/manifest
```

- **No output → done.** Your build reproduced the committed per-scene bytes exactly, so
  your addition changed nothing. This is the expected result for a purely additive,
  unimported export, and it needs only the one build.
- **Any file listed → attribute the delta before concluding anything.** The committed
  baseline can be stale (someone else's change), so re-run without your Lite files:
    ```
    git stash push -- packages/babylon-lite/src/<your-files>
    pnpm build:bundle-scenes
    git status --porcelain lab/public/bundle/manifest   # same files still dirty?
    git stash pop
    ```
    Same set dirty both ways → pre-existing drift, not yours (commit the regenerated
    manifests). Dirty only **with** your change → the addition is **not**
    tree-shakeable; revert it and record `🔧 Needs Lite core`.

A non-zero exit from `build:bundle-scenes` means a **ceiling** was exceeded — that is a
hard stop, and raising a ceiling requires explicit user approval.

The build also regenerates the tracked per-scene manifests, so include any that
legitimately changed in your commit.

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
- [ ] **(Task 3)** Every `unsupported(...)` stub you wrote or left in place this run
      carries a named **structural** blocker (not "Lite has no equivalent"), and no test
      asserts `.toThrow()` on a surface moves 1–4 could back.
- [ ] Any Lite addition this run is small, contained, and objective (no new subsystem,
      no open design question) — otherwise it was left as `🔧 Needs Lite core` with the
      design question stated.
- [ ] `COMPAT-STATUS.md` grew no log: no dated run note, "re-check" entry, or changelog
      section was appended; every update edits state in place.
- [ ] **(Task 3)** Every `@babylonjs/core` + `@babylonjs/loaders` symbol maps to a row
      (`✅`/`⚡`/`🔧`/`❌`) — ledger empty — and none resolves to a bare "not exported"
      error (each is wrapped or a throwing stub).
- [ ] **(Task 3)** The **Supported APIs at a glance** table in
      `packages/babylon-lite-compat/README.md` still reflects the matrix (any changed
      area's roll-up + note updated).
- [ ] **(Task 1)** `Last synced BJS commit`, `Last synced Lite commit` and
      `Last sync date` updated to `NEW_BJS_SHA` / `NEW_LITE_SHA` / today.
- [ ] Tests, both typechecks, ESLint, and Prettier all pass.

If any box is unchecked, the run is not done.

---

## Update `COMPAT-STATUS.md` (required, last step)

**`COMPAT-STATUS.md` records current state, never history.** Edit existing rows and
prose in place. Do **not** append dated run notes, "Task N re-check (YYYY-MM-DD)"
entries, changelog blocks, or any other append-only log — the file must not grow by one
section per run. Git history, the PR description, and your run summary carry the
per-run narrative; anything a future run needs must be expressed as _state_ (a row, a
blocker entry, a status line), not as an entry in a log.

Update the part each task touched:

1. **(Task 3)** Update changed feature rows and add rows for any newly enumerated
   core/loaders symbols (even unsupported ones).
2. **(Task 2, only if a scene was unblocked)** Update the **Lab scene coverage**
   section — move newly-working scenes into the working list (bump the count) and
   revise/remove blocker rows. When nothing was unblocked, the existing "Task 2 status"
   line already says so — leave it alone rather than adding a note saying it again.
3. **(Task 1)** Set `Last synced BJS commit` to `NEW_BJS_SHA`, `Last synced Lite commit`
   to `NEW_LITE_SHA`, and `Last sync date` to today; update `Lite compat package version`
   if it changed.

Then **sync the README summary** (`packages/babylon-lite-compat/README.md`,
**Supported APIs at a glance**): a per-_feature-area_ roll-up (one `✅`/`⚡`/`❌` per
area; `🔧` rolls up to the more user-visible of `⚡`/`❌`). Update any area whose
roll-up or one-line note this run made inaccurate. It's a summary — not per-symbol —
and ships to npm, so add no per-symbol rows and no internal-doc links.

---

## Guardrails

- **Cardinal rule (restated):** compat is a pure API layer — feature logic lives in
  Lite, never in compat. A wrapper that does feature work itself is a defect even if
  its tests pass. Any Lite addition to support compat must be 100% tree-shakeable —
  and making one is a **normal, expected** outcome, not an escalation.
- **Every `unsupported(...)` needs a named structural reason.** Before writing one,
  work the "Choosing your move" procedure and state in the code comment and the matrix
  row _why_ moves 1–4 are unavailable. "Lite has no equivalent" is the trigger for
  move 2, not a justification for move 3. An unjustified stub is a defect on par with
  putting feature logic in compat.
- **Lite additions stay mechanical.** Move 2 covers small, contained, objective
  additions only. Anything that introduces a subsystem, a new concept in Lite's model,
  or a real design choice is a `🔧 Needs Lite core` row for a human — not unattended
  engine design.
- **`COMPAT-STATUS.md` is state, not a log.** Never append dated run notes or
  changelog entries; revise rows and prose in place so the file stays a constant size.
- **Exact API parity:** exported symbols carry the identical BJS name and public
  member shapes, so ported code runs against the compat barrel without renaming a
  single import or member. A divergent public name is a parity bug. Optional-parameter
  **defaults** are part of that shape — forward BJS's value, never Lite's.
- The compat package is **opt-in and excluded from Lite bundle-size ceilings**, but
  must stay free of module-level side effects so it never bloats a non-importing
  consumer.
- Do not run `pnpm test:perf` or the Lite parity suite; they are unrelated to compat
  work. A purely additive, unimported Lite export cannot change rendering, so the
  bundle build above is the only proof required. (The parity suite also rewrites
  `reference/**` golden images, which are immutable — another reason not to run it.)
- Keep wrappers honest: a feature is `✅ Full`/`⚡ Partial` only if it actually works
  by delegating to Lite. Mark `🔧`/`❌` and throw only after the decision procedure
  turned up a real blocker — "in doubt" means you checked and hit a wall, not that you
  didn't check.
- **When Task 2 fires, land the scene — don't just unblock it:** drive it to MAD ≈ 0
  and into the working list (expect a chain of several gaps). If nothing was
  unblocked, zero scene work is correct.
- Summarise at the end, per task: **(Task 1)** changes acted on, plus `NEW_BJS_SHA`
  and `NEW_LITE_SHA`;
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
