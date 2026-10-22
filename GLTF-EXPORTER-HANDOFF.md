# glTF exporter — handoff

> Temporary. Delete before merging, together with `GLTF-EXPORTER-WORK-PLAN.md` and `scripts/gltf-export-parity/`.

## What this is

`exportSceneAsGlb(scene): Promise<Blob>` for Babylon Lite: a leaf module in `packages/babylon-lite/src/export-gltf/`. Nothing else in production code changes except one re-export in `index.ts`.

- **Spec:** `docs/lite/architecture/60-gltf-exporter.md` is the one-shot spec and the source of truth for behaviour, scope, tests and the file manifest.
- **History and follow-ups:** `GLTF-EXPORTER-WORK-PLAN.md` has the run history, the judgment calls, and the follow-up issue text (§ "Follow-up issue").

## Branches on `alexchuber/Babylon-Lite`

No PR has been opened.

| Branch                              | Contents                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `feat/gltf-exporter-implementation` | Everything mergeable: the exporter, unit/plumbing tests, visual parity scenes 316, 317, 318, 324 and 327, docs, and this handoff. **Work from here.**                                                  |
| `docs/gltf-exporter-architecture`   | The spec alone, kept identical to the copy on the feature branch.                                                                                                                                      |
| `wip/gltf-export-parity-blocked`    | The feature branch plus seven written visual scenes (319, 320, 321, 322, 323, 325, 326) that match Babylon.js only once skipped work lands. Rebase it onto the feature branch before reviving a scene. |

## State at handoff (all green)

- **Unit:** 468 tests. Run `pnpm exec vitest run --project unit tests/lite/unit/export-gltf/`.
- **Plumbing:** 29 tests. `tests/lite/plumbing/export-gltf.spec.ts` does round trips over 10 assets plus a native scene. `export-gltf-bjs-ports.spec.ts` holds the Babylon.js unit-test ports.
- **Visual parity:** 5 scenes covering 6 of Babylon.js's 26 "GLTF Serializer" visual tests. The spec's "Visual parity suite" section maps all 26.
- **Static checks:** `tsc` (package, tests, lab), ESLint and Prettier are clean.

## Running things in a sandbox

There is no Chrome or GPU in the sandbox, so use Playwright's Chromium with SwiftShader under `xvfb-run -a`. Save this file as `_pw-local.config.ts` in the repo root and delete it afterwards:

```ts
import base from "./playwright.config";
export default {
    ...base,
    retries: 0,
    workers: 1,
    use: {
        ...base.use,
        channel: undefined,
        headless: true,
        launchOptions: {
            executablePath: "/opt/pw-browsers/chromium",
            args: [
                "--force-color-profile=srgb",
                "--enable-unsafe-webgpu",
                "--enable-features=Vulkan",
                "--use-vulkan=swiftshader",
                "--use-angle=swiftshader",
                "--disable-vulkan-fallback-to-gl-for-testing",
                "--ignore-gpu-blocklist",
            ],
        },
    },
};
```

- **Plumbing and procedural parity specs (316, 317, 324):**
  `xvfb-run -a pnpm exec playwright test --config _pw-local.config.ts <spec>`.
- **Scenes that load playground assets (318, 327, and most wip scenes):** the sandbox cannot reach the asset hosts.
    1. Run `scripts/gltf-export-parity/build-asset-mirror.sh`. It rebuilds the assets from GitHub and npm. The one exception is `i.imgur.com/JbvoYlB.png`, which you add by hand.
    2. Start the lab: `LAB_DEV_PORT=5179 pnpm --filter @babylon-lite/lab dev`.
    3. Use `npx tsx scripts/gltf-export-parity/xrun.mjs golden|lite|fidelity …`. It does what the spec does, serving the assets from the mirror.
- **Bundle ceilings:** run `node scripts/gltf-export-parity/seed-bundle-asset-cache.mjs`, then `BUNDLE_SOFTWARE_RENDER=1 pnpm exec tsx scripts/build-bundle-scenes.ts --scenes sceneN` (after `pnpm build:lib`).
- **Porting more Babylon.js visual tests:** see `scripts/gltf-export-parity/visual-port-brief.md` (method, fidelity gate, checklist) and `playground-facts.md` (each snippet's exact content).

## Open work

1. **File the follow-up issue** in `alexchuber/todo` once this agent's GitHub account can reach it. The text is in `GLTF-EXPORTER-WORK-PLAN.md` § "Follow-up issue", and the project has a copy as `claude/gltf-exporter-follow-up-issue.md`.
2. **User decisions pending:**
    - Multi-camera export, which blocks 3 camera tests.
    - Whether to take on any out-of-scope capability. Each one needs a change outside `export-gltf/`, and the issue lists which tests it unblocks:
        - skins
        - samplers
        - original image bytes
        - CPU retention of tangents and colors
        - natively authored animation export
3. **Renderer gaps found by the visual scenes** (not exporter work):
    - PBR direct lighting without an environment
    - metallic PBR under a hemispheric light
    - gamma-space DDS environments
    - `FALLOFF_GLTF`
4. **Before merging:**
    - Delete the temporary files listed at the top.
    - Squash: early `wip(...)` commits have failing unit tests mid-update.
    - Confirm that CI runs the new plumbing specs and parity scenes; they have only run locally.
    - Archive the stale v1 planning docs on `feat/gltf-export`.

## Working agreements with the user

- **Branches only, no PRs.** End commit messages with the `Co-Authored-By` and `Claude-Session` trailers.
- **Scope:** anything that needs code outside `export-gltf/` is out of scope unless the user says otherwise. Record it as an issue item instead.
- **No threshold-covered failures:** don't keep a test that passes only through a threshold covering skipped work. Move it to the wip branch and track it in the issue.
- **Faithful ports:** Babylon.js visual tests are ported as they are. A Babylon.js reference page must pass the fidelity gate against Babylon.js's own reference image before its golden is captured.
- **Delegation:** hand monotonous coding and research to cheaper subagents (Sonnet, medium effort), and use independent reviewers before finalizing.
- **Repo rules:** follow `GUIDANCE.md` and `AGENTS.md`. Never run the full suites. The user approved local visual runs for this work.
