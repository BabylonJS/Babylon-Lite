# Update the Babylon Lite Compat Layer

You maintain `@babylonjs/lite-compat` — the Babylon.js-shaped compatibility layer
that sits on top of the Babylon Lite public API (package at
`packages/babylon-lite-compat/`). Your job in this skill is to **make progress on
three fronts**: react to upstream Babylon.js / Babylon Lite changes (Task 1), get
more of the lab's oracle scenes rendering through the compat layer (Task 2), and
close gaps between the compat surface and the Babylon.js API (Task 3) —
implementing what is now possible, adding tests, and updating the status file for
each. **Task 2 is the required deliverable of every run: land at least one new lab
scene at pixel parity, even when it takes clearing a chain of hard blockers.**

The single source of truth for all three is
`packages/babylon-lite-compat/COMPAT-STATUS.md`, which tracks them in three places:

| Task | Goal                          | Tracked in `COMPAT-STATUS.md` by                                  |
| ---- | ----------------------------- | ----------------------------------------------------------------- |
| 1    | Upstream diffs                | the `Last synced BJS commit` + `Last sync date` markers           |
| 2    | Lab-scene coverage (req. win) | the **Lab scene coverage** section (working list + blocker table) |
| 3    | API parity                    | the per-area **status matrix** (a row per core/loaders symbol)    |

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

Every run advances the compat layer on three fronts. **Task 2 is the headline
deliverable: every run must land at least one new lab scene at MAD ≈ 0** (see the
firm requirement in Task 2). Tasks 1 and 3 are run alongside it and their status
must be left accurate, but a run that ships zero new working scenes is incomplete.

- **Task 1 — React to upstream diffs.** Pick up what changed in Babylon.js and
  Babylon Lite since the last sync and act on anything newly relevant.
- **Task 2 — Advance lab-scene coverage (required win).** Get **at least one more**
  of the lab's Babylon.js oracle scenes rendering at pixel parity through the compat
  layer — every run, even when it's hard.
- **Task 3 — Close API-parity gaps.** Bring the compat surface closer to the full
  `@babylonjs/core` + `@babylonjs/loaders` public API. Every run must land at least
  one of: add a missing API (even as a stub), upgrade an unsupported/partial API to
  a real implementation, or prove full coverage with no remaining upgrades possible
  (see Task 3).

Task 3 carries a hard **completeness invariant** — every core/loaders symbol must
have a status row (see Task 3 below). The three feed each other: a diff in Task 1
can unblock a lab scene in Task 2 or a parity gap in Task 3, and the lab-scene
recipe in Task 2 is usually the fastest way to prove an API gap in Task 3 is
implementable — which is why the new working scene is the run's anchor, not an
optional extra.

---

## Task 1 — React to upstream BJS/Lite diffs

Use the diffs since the last sync to find — and prioritise — what changed.

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
    them against the `🔧 Needs Lite core` / `⚡ Partial` / `❌` rows, since they may
    now be upgradable (a new Lite capability can unblock a lab scene in Task 2 or a
    parity gap in Task 3).
2. **Find what changed in Babylon.js core/loaders since `LAST_BJS_SHA`** (the
   `Last synced BJS commit` recorded in `COMPAT-STATUS.md`).
    - Latest master HEAD: `https://api.github.com/repos/BabylonJS/Babylon.js/commits/master`
      (record the new SHA as `NEW_BJS_SHA`).
    - Compare view: `https://api.github.com/repos/BabylonJS/Babylon.js/compare/LAST_BJS_SHA...master`
      — act only on changes under `packages/dev/core/src/**` and
      `packages/dev/loaders/src/**`. New symbols here feed Task 3's ledger; the diff
      just tells you which ones are _new_ so you prioritise them.

---

## Task 2 — Advance lab-scene coverage (required win)

The lab renders each Babylon.js oracle scene (`lab/lite/src/bjs/sceneN.ts`) through
the compat layer at `/compat/sceneN.html`. A scene **works** when its compat render
matches the native Lite port (`/lite/sceneN.html`) at MAD ≈ 0. The **Lab scene
coverage** section of `COMPAT-STATUS.md` is the live record: a working-scene list
(with a count) plus a table grouping the rest by blocker.

**This is the run's required deliverable: finish with at least one scene that was
not working before now rendering at MAD ≈ 0, opted into `scene-config.json`, and
moved into the working list.** Do not stop at "I added an API the scene needs" or
"I advanced it to its next blocker" — that is not done. Push a single scene all the
way to parity, however many gaps it takes.

1. Read the **Lab scene coverage** section — the working list and the blocker table.
2. **Pick a target scene and commit to it.** Prefer a blocker group where the fix is
   likely to unblock several scenes at once and where the native Lite port already
   renders the feature (proof Lite can back it). Pick the candidate with the
   shortest path to parity, but once chosen, **see it through** rather than hopping
   to a different scene when the first gap is cleared.
3. **Diagnose the _full_ chain of blockers, not just the first.** Open
   `/compat/sceneN.html`, read the console error, fix/stub that gap, then re-run and
   read the _next_ error. Most blocker-table scenes fail on a **chain** of missing
   APIs (e.g. `getChildMeshes` → `mesh.clone` → a PBR property); the scene only
   counts when the whole chain is cleared and it renders. Keep iterating
   error-by-error until the canvas renders and `dataset.ready` is set.
4. For each gap in the chain, read **both** the BJS oracle (`lab/lite/src/bjs/sceneN.ts`)
   and the native Lite port (`lab/lite/src/lite/sceneN.ts`). **If the Lite port
   renders the feature, Lite can back it** — that port is a working, copy-able
   recipe for the exact Lite API/call sequence to wrap. Implement or extend the
   compat wrapper to match (see "Implementation patterns").
5. Measure compat-vs-lite parity (in-browser MAD diff of `/compat/sceneN` vs
   `/lite/sceneN`; use `?freeze=1` / `?seekTime=0` for animated scenes to get a
   deterministic frame). Drive it to MAD ≈ 0. If it renders but diverges, use a
   3-way comparison (compat vs lite vs the committed `babylon-ref-golden.png`) to
   localise whether the gap is in compat or the Lite port, and keep fixing.
6. When the scene reaches MAD ≈ 0, set `"compatParity": true` in
   `scene-config.json`, then regression-check a sample of already-working scenes so
   the change didn't break them.
7. Update the **Lab scene coverage** section: move the newly-working scene(s) into
   the working list (bump the count) and update or remove the blocker row.

**If a chosen scene proves genuinely unreachable this run** (e.g. it bottoms out on
a real `🔧 Needs Lite core` gap that can't be made tree-shakeable), document
precisely why in the blocker row — then **pick another scene and land it instead.**
"Every candidate I tried was hard" is not an exemption; difficulty is expected. The
only acceptable zero-scene outcome is a written, evidence-backed argument that
_every_ remaining not-working scene is blocked on a Lite-core change — which, given
the size of the blocker table, should essentially never happen.

> Don't conflate "no compat wrapper yet" with "Lite can't do it." A scene whose
> native Lite port renders the feature is almost never a genuine `🔧 Needs Lite
core` — it just needs the wrapper. Only record a `🔧`/`❌` blocker after confirming
> the Lite port itself cannot render it.

---

## Task 3 — Close API-parity gaps (coverage audit, full enumeration)

**Every public symbol exported from BJS core + loaders MUST have a row in
`COMPAT-STATUS.md`.** A symbol with no row is an undetected gap. The Task 1 diffs
alone cannot guarantee this — they only surface what _changed_, never what already
existed and was never triaged. So every run does a **full enumeration** of the
core + loaders export surface and reconciles it against the status matrix. That
enumeration is the mandatory completeness gate; _implementing_ the gaps it surfaces
is incremental, best-effort progress.

**Required outcome (every run must land at least one of these):**

1. **Add at least one missing API** (property, function, class, enum, or member) —
   even if it ships as a throwing `unsupported(...)` stub — so a real core/loaders
   symbol that previously gave a bare "not exported" error now resolves.
2. **Upgrade at least one unsupported/partial API to a real implementation** —
   replace a throwing stub (or fill in a missing member on a `⚡ Partial` wrapper)
   with working behaviour backed by the Lite API.
3. **Prove full coverage with no further upgrades possible** — demonstrate, with
   evidence, that every core/loaders symbol already has a row _and_ that every `❌` /
   `🔧` row was re-checked this run and genuinely cannot be backed by the current
   Lite API. This is the only outcome that needs no code change, and it requires the
   re-triage in step 4 to be exhaustive — not assumed.

Landing the Task 2 scene often satisfies outcome 1 or 2 as a side effect (the scene
fails on a missing/stubbed API you then add) — but confirm which outcome you hit and
record it. "I enumerated the surface but changed nothing" only counts if you can back
outcome 3.

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
   row** — against the _current_ Babylon Lite public API. Do not trust the prior
   status; the whole point is to catch things Lite can now back. For each:
    - Search Lite's surface for a backing capability before concluding it is
      unsupported: read `packages/babylon-lite/src/index.ts` and grep
      `packages/babylon-lite/src/**` for related names (e.g. searching `pick`
      would have surfaced `createGpuPicker` / `pickAsync`).
    - **Check for a native Lite lab scene demonstrating the feature before marking
      it `❌`/`🔧`.** Most lab scenes have both a BJS oracle
      (`lab/lite/src/bjs/sceneN.ts`) and a native Lite port
      (`lab/lite/src/lite/sceneN.ts`). If the Lite port renders the feature, Lite
      **can** back it — read that port to learn the exact Lite API/call sequence to
      wrap (it is a working, copy-able recipe), then mirror it in the compat
      wrapper. A feature with a working Lite lab scene is almost never a genuine
      `🔧 Needs Lite core`; treat "no compat wrapper yet" and "Lite can't do it" as
      different conclusions. (Driving these lab scenes to parity is **Task 2**.)
    - If Lite can back it → implement the wrapper (see "Implementation patterns").
    - If Lite _almost_ backs it but the clean surface is missing, consider adding a
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

## Implementation patterns

When Task 2 or Task 3 surfaces a symbol that is now implementable on Lite, build the
wrapper following the existing patterns in `packages/babylon-lite-compat/src/`:

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

Task 3's coverage ledger and Task 2's new working scene are both hard gates. Do not
finish until:

- [ ] **(Task 2 — required win)** At least one scene that was _not_ working before
      this run now renders at MAD ≈ 0, has `"compatParity": true` in
      `scene-config.json`, and has moved into the **Lab scene coverage** working
      list (count bumped). Advancing a scene to its next blocker without landing it
      does **not** satisfy this. (The only exemption is a written, evidence-backed
      proof that _every_ remaining not-working scene is blocked on a non-tree-shakeable
      Lite-core change — see Task 2.)
- [ ] **(Task 3 — required outcome)** This run landed at least one of: (a) a newly
      added API (even a throwing `unsupported(...)` stub) for a core/loaders symbol
      that previously bare-failed; (b) a stub/partial API upgraded to a real
      Lite-backed implementation; or (c) an evidence-backed proof that coverage is
      complete and no `❌`/`🔧` row can currently be upgraded. State which.
- [ ] **(Task 3)** Every public symbol exported by `@babylonjs/core` and
      `@babylonjs/loaders` maps to a row in `COMPAT-STATUS.md`
      (`✅` / `⚡` / `🔧` / `❌`) — the coverage ledger is empty.
- [ ] **(Task 3)** No core/loaders symbol resolves to a bare "not exported" error —
      every one is either wrapped or shipped as a throwing `unsupported(...)` stub.
- [ ] **(Task 3)** Every existing `❌` / `🔧` row was re-checked against the
      _current_ Lite API this run (not assumed from the previous sync).
- [ ] **(Task 3)** The high-level support table in
      `packages/babylon-lite-compat/README.md` (**Supported APIs at a glance**) still
      reflects the `COMPAT-STATUS.md` matrix — any feature area whose roll-up status
      (`✅` / `⚡` / `❌`) changed this run is updated, and its note is still accurate.
- [ ] **(Task 1)** `Last synced BJS commit` / `Last sync date` are updated to the
      reconciled `NEW_BJS_SHA` / today.
- [ ] **(Task 2)** The **Lab scene coverage** section reflects reality: every scene
      you drove to MAD ≈ 0 is in the working list (count bumped) and opted into
      `scene-config.json`, and blocker rows are updated.
- [ ] Tests, both typechecks, ESLint, and Prettier all pass.

If any box is unchecked, the run is not done.

---

## Update `COMPAT-STATUS.md` (required, last step)

`COMPAT-STATUS.md` tracks all three tasks, so update the part each one touched:

1. **(Task 3)** Update every feature row you changed to its new status, and add
   rows for any newly enumerated BJS core/loaders symbols (even unsupported ones).
2. **(Task 2)** Update the **Lab scene coverage** section — move newly-working
   scenes into the working list (bump the count) and revise or remove blocker rows.
3. **(Task 1)** Set `Last synced BJS commit` to `NEW_BJS_SHA` and `Last sync date`
   to today's date.
4. If the compat package version changed, update `Lite compat package version`.

Then **sync the consumer-facing README summary** (`packages/babylon-lite-compat/README.md`,
the **Supported APIs at a glance** section): it is a per-_feature-area_ roll-up of the
`COMPAT-STATUS.md` matrix (one `✅` / `⚡` / `❌` per area, `🔧` rolls up to the most
user-visible of `⚡`/`❌`). If a change this run flips an area's roll-up status or makes
its one-line note inaccurate (e.g. a previously-unsupported feature is now wrapped, or a
newly-enumerated symbol belongs in an existing area), update that row. The README table
is a summary, not the per-symbol source of truth — do not add a row per symbol there, and
keep it free of links to internal docs (it ships to npm).

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
- **Land the scene, don't just unblock it.** Adding an API a scene needs, or
  advancing it to its next error, is not a Task 2 win — a run is only complete when
  at least one previously-broken scene actually renders at MAD ≈ 0 and is in the
  working list. Expect to clear a chain of several gaps for one scene; that is the
  job, not a reason to stop.
- Summarise at the end, per task: **(Task 1)** which BJS/Lite changes you acted on
  and the new `NEW_BJS_SHA`; **(Task 2)** which lab scene(s) you **landed at MAD ≈ 0**
  (the required win) and the new working count; **(Task 3)** which required outcome
  you hit — the missing API you added, the stub/partial you upgraded to a real
  implementation, or the proof that coverage is complete — plus the size of the
  coverage ledger (and that it is now empty), any tree-shakeable Lite-core additions
  (with the bundle-diff proof), and the test/typecheck/lint results.
