# Copilot Instructions — Babylon Lite

## Debugging Visual/Rendering Differences

**MANDATORY: Use tools before guessing.** When investigating any visual mismatch
between Babylon Lite and Babylon.js:

1. **Capture both sides with Spector.GPU** — always capture a frame from the BJS
   reference page AND the Lite page before theorizing. Compare shaders, textures,
   uniforms, and draw commands from actual GPU data.

2. **Dump pixel values** — use Python/Pillow or similar to read exact RGB values
   from screenshots at multiple positions. Never eyeball or assume pixel colors.

3. **Check what's actually rendering** — change `clearColor` to a bright
   diagnostic color (e.g., red) to confirm whether a mesh is drawing or the
   background is just the clear color.

4. **Read the BJS source** — use the explore agent to check the actual Babylon.js
   code paths (at `C:\Repos\Babylon.js`) before assuming how BJS works.

**The rule: 1 capture + 1 pixel dump before any code change.** Don't try to
reverse-engineer colors mathematically when you can just read them from a
capture. Don't guess texture content when Spector shows you exactly what's bound.

## Spector.GPU Usage

```bash
# Quick summary of any WebGPU page
node C:\Repos\Spector.gpu\skills\spector-gpu-capture\capture-cli.js <URL> --summary --headed --wait 10000

# Full capture with screenshot
node C:\Repos\Spector.gpu\skills\spector-gpu-capture\capture-cli.js <URL> --headed --wait 10000 --output capture.json --screenshot shot.png
```

Use `--wait 15000` for Lite pages (compute shaders need time).

## Build & Test

Babylon-Lite (WebGPU) package:
- `pnpm test` — Vitest unit/bundle-size tests
- `pnpm test:parity` — Playwright visual parity tests (needs Chrome, not headless)
- `pnpm dev:lab` — dev server (port 5174+, auto-increments if busy)

**Lite GL (`@babylonjs/lite-gl`, WebGL2 sibling).** Commands, coverage policy,
the experience-aware lab dashboard, and **spector.js (SpectorJS) debugging** are
documented in `docs/gl/welcome.md` (full module spec:
`docs/gl/architecture/00-lite-gl.md`).

## Key Architecture Facts

- BJS default environment loads `backgroundSkybox.dds` from CDN for the skybox —
  this is a SEPARATE texture from the specular `.env` file. Its output matches
  `clearColor` by design.
- Babylon.js passes `this.exposure` directly as `exposureLinear` uniform
  (NOT `1/2^exposure`).
- The specular cubemap is pre-filtered for PBR roughness at each mip level —
  it is NOT suitable as a raw skybox texture.
