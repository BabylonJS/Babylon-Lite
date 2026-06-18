# Babylon Lite

A WebGPU-exclusive, tree-shakable 3D engine that produces pixel-identical output to Babylon.js — in a fraction of the bundle size.

📖 **[Documentation](docs/lite/00-welcome.md)** — Start with Welcome, then [Getting Started](docs/lite/01-getting-started.md), the [Feature Comparison](docs/lite/02-feature-comparison.md), and the [Porting Guide](docs/lite/03-porting-guide.md)

🤝 **[Contributing](CONTRIBUTING.md)** — How to add scenes, tests, and contribute code

## Prerequisites

- **Node.js** ≥ 18
- **pnpm** ≥ 9 (`corepack enable` to activate the version pinned in `package.json`)
- A browser with **WebGPU** support (Chrome 113+, Edge 113+, or recent Firefox and Safari)

## Getting Started

```bash
# 1. Install all workspace dependencies (links the babylon-lite package)
pnpm install

# 2. Install Playwright browsers (needed for parity & bundle-size tests)
pnpm exec playwright install

# 3. Start the dev server (builds bundle scenes, then launches Vite on port 5174)
pnpm dev:lab
```

Open **http://localhost:5174** to browse the scene gallery.

## Available Scripts

| Command                    | Description                                                   |
| -------------------------- | ------------------------------------------------------------- |
| `pnpm dev:lab`             | Build bundle scenes + start the lab dev server                |
| `pnpm build`               | Build the `babylon-lite` library                              |
| `pnpm build:bundle-scenes` | Generate production bundles + `manifest.json` for the gallery |
| `pnpm test`                | Build bundle scenes, then run parity and bundle-size tests    |
| `pnpm test:parity`         | Run Playwright visual parity tests against golden references  |
| `pnpm test:perf`           | Run Playwright performance benchmarks                         |
| `pnpm test:bundle-size`    | Run bundle-size ceiling tests                                 |
| `pnpm lint`                | Run ESLint, then type-check with `tsc --noEmit`               |

## Project Structure

```
packages/babylon-lite/   # The engine library
lab/         # Scene gallery & dev playground (Vite)
tests/lite/unit/              # Vitest unit tests (pure Node.js, no GPU)
tests/lite/plumbing/          # Playwright GPU integration tests (dispose, material-swap)
tests/lite/parity/scenes/     # Playwright visual parity tests (pixel-diff)
tests/lite/perf/              # Playwright performance benchmarks
reference/lite/               # Golden reference screenshots (immutable)
scripts/                 # Build & bundling utilities
docs/lite/architecture/       # One-shot architecture docs
```

## Adding Tests

### Test Structure

```
tests/lite/
  unit/              # Vitest — pure Node.js shader/math tests (no GPU)
  plumbing/          # Playwright — dispose, material-swap (requires WebGPU)
  parity/
    scenes/          # Playwright — pixel-diff against golden references (requires WebGPU)
    compare-utils.ts # Shared image comparison helpers
  perf/              # Playwright — RAF performance benchmarks (requires WebGPU)
```

### Unit Tests (vitest)

For pure logic tests (shaders, math, composition) that don't need a browser or GPU:

1. Create `tests/lite/unit/my-feature.test.ts`
2. Use vitest APIs (`describe`, `it`, `expect`)
3. Run: `pnpm exec vitest run`

### Plumbing Tests (Playwright + WebGPU)

For GPU integration tests (dispose, material-swap, lifecycle):

1. Create a test page: `lab/lite/my-test.html` + `lab/lite/src/my-test.ts`
2. Add the HTML entry to `lab/vite.config.ts` (auto-detected if in root)
3. Create `tests/lite/plumbing/my-test.spec.ts`
4. Run: `pnpm exec playwright test tests/lite/plumbing/my-test.spec.ts`

> CI uses Chrome's SwiftShader Vulkan backend — WebGPU works without a real GPU.

### Scene Parity Tests (Playwright + WebGPU)

For pixel-diff visual regression tests against Babylon.js golden references:

1. Create the Lite scene: `lab/lite/sceneN.html` + `lab/lite/src/lite/sceneN.ts`
2. Create the BJS reference: `lab/lite/babylon-ref-sceneN.html` + `lab/lite/src/bjs/sceneN.ts`
3. Add entries to `lab/vite.config.ts` rollup inputs
4. Capture a golden reference and save to `reference/lite/sceneN-<slug>/babylon-ref-golden.png`
5. Save a downscaled JPG thumbnail (≤720p) of the golden to `lab/public/thumbnails/sceneN.jpg`
6. Add scene config to `scene-config.json` with `id`, `slug`, `name`, `maxMad`
7. Create `tests/lite/parity/scenes/sceneN-<slug>.spec.ts` using `compare-utils.ts` helpers
8. Add a bundle-size ceiling in `tests/lite/parity/bundle-size.spec.ts` (never raise without approval)
9. Run: `pnpm exec playwright test tests/lite/parity/scenes/sceneN-<slug>.spec.ts`

### CI Workflows

| Workflow        | Trigger     | What it runs                    |
| --------------- | ----------- | ------------------------------- |
| **Lint**        | PR → master | ESLint + `tsc --noEmit`         |
| **Unit**        | PR → master | Vitest + plumbing tests         |
| **Bundle Size** | PR → master | Runtime KB ceiling checks       |
| **Parity**      | manual      | Scene pixel-diff vs golden refs |
| **Perf**        | manual      | RAF performance benchmarks      |

## Troubleshooting

### Vite can't resolve `"babylon-lite"`

Run `pnpm install` — the workspace symlink is missing.

### Playwright "did not expect test() to be called here"

A rogue `node_modules/playwright/` directory (not managed by pnpm) conflicts with the pnpm-managed copy. Fix:

```bash
rm -rf node_modules/playwright
```

**Important:** always use `pnpm exec` for Playwright commands (not `npx` or `npm`), e.g. `pnpm exec playwright install`. Using `npx` can recreate the rogue directory.

### 404 for `/bundle/manifest.json`

Run `pnpm build:bundle-scenes` (or use `pnpm dev:lab` which does this automatically).

### 404 for `test-actual.png` images

These are generated by parity tests. Run `pnpm test:parity` once to create them.

### 404 for `/perf-manifest.json`

Run `pnpm test:perf` to generate performance data for the dashboard.
