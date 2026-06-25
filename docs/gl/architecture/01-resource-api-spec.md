# lite-gl Resource API — convergence spec (render targets + textures)

> Status: **implemented on `newdemo`** — this branch ships the converged surface
> below (see `packages/babylon-lite-gl/src/{texture,render-target}.ts` and the
> `tests/gl/build/public-api.test.ts` contract). The remaining work is for the
> `theduck` and `tinylottie` branches to rebase their additions onto this one
> API, so the render-target and texture work co-merges onto `lite-gl` without two
> contradictory `createRenderTarget`/`createRawTexture` surfaces. The
> reconciliation matrix in §5 records the pre-convergence state of each branch and
> is kept for historical context.

## 1. Why this spec exists

Three branches independently expanded the same lite-gl resource modules off the
same base (`47f028a`):

| Branch | render-target.ts | texture.ts additions | other |
|---|---|---|---|
| `newdemo` | RGBA8 + opt depth, **ping-pong**, options-object, null-bind, null-safe dispose | `pickSizedInternalFormat` (LDR+HDR table) | the 2 Shadertoy demos + scene8 |
| `theduck` | RGBA8 **+ HDR float/half + stencil + mipmaps + readback**, **positional w/h**, separate `unbindRenderTarget` | `updateRawTexture`, `updateTextureSamplingMode`, `updateTextureWrapMode`, `createTextureFromHandle` | `mesh.ts`, `depth-stencil.ts`, `scissor.ts` |
| `tinylottie` | — (no lite-gl RTT) | `createDynamicTexture`, `updateDynamicTexture`, `clearDynamicTextureSource` | `babylon-lite-lottie` pkg |

Two problems:

1. **Source-incompatible duplicates.** `theduck` and `newdemo` both export
   `createRenderTarget` with **different signatures** (`(engine, w, h, opts?)`
   vs `(engine, opts)`) and different `GLRenderTarget`/`GLRenderTargetOptions`
   shapes. Whichever lands first, the other can't merge its `render-target.ts`,
   and consumer code won't compile against the other.
2. **Fat cores that can't tree-shake.** `theduck`'s `createRenderTarget` bakes
   HDR float/half-float + stencil + mipmaps into the one function; `createRawTexture`
   (all branches) bakes the full `pickSizedInternalFormat` LDR+HDR table + mipmap
   path into the always-included path. A consumer who only needs an RGBA8 target
   (post-processing, the demos) still ships the HDR/stencil/mipmap/readback code —
   the opposite of lite-gl's "import only what you use, `sideEffects:false`".

One bright spot: all three independently converged on the **identical**
`state.boundFramebuffer: WebGLFramebuffer | null` cache field — so the core
state-cache contract is already consistent.

## 2. Design principles

**P1 — Format-agnostic minimal cores.** `createRenderTarget` wires "an FBO around
a color `GLTexture` + optional depth"; `createRawTexture` uploads "a byte texture
+ sampler params". Neither hard-codes exotic formats.

**P2 — The options-vs-export rule (the key heuristic).**
- An **`option` is allowed** only if it toggles a GL parameter *already on the
  core path*: `minFilter`/`magFilter`/`wrapS`/`wrapT`/`invertY`/`generateDepthBuffer`.
- A feature becomes a **separate tree-shakeable export** (not an option) when
  supporting it would pull a distinct code path or lookup table that non-users
  would otherwise ship: HDR sized-format resolution, stencil renderbuffers,
  mipmap pyramids, MRT, pixel readback, compressed/cube formats, dynamic
  (canvas) uploads, sub-image updates.

**P3 — Naming (already settled by the WebGPU-lite compat rename).** Functions are
prefix-free (`createRenderTarget`, not `createGLRenderTarget`); types are
`GL`-prefixed (`GLRenderTarget`); option bags use the `Options` suffix; every
function is **engine-first**. Matches `@babylonjs/lite`'s `createRenderTarget` /
`createRenderTargetTexture` and lite-gl's own `createRawTexture`/`bindTexture`.

**P4 — Sub-entry packaging.** Core stays in the main barrel + `/render-target`;
heavier opt-ins are separate exports and, when large, separate sub-entries
(`/dynamic-texture`, `/mesh`, `/depth-stencil`, `/scissor`, plus existing
`/sprites`, `/html-texture`). Package is `sideEffects:false`.

**P5 — One restore mechanism.** Every texture variant is the same mutable-handle
`GLTexture`. A render target's FBO/renderbuffers — and its default (owned) color
texture — are rebuilt by the target's own restore hook; a bring-your-own
`colorTexture` is restored by the engine's standard texture path and the target
reattaches the swapped handle. A render target therefore *composes* a `GLTexture`
rather than owning a bespoke color path — which is exactly what makes
"bring-your-own-color-texture" (P2's HDR answer) fall out for free.

## 3. Render Target API (converged, tiered)

### Tier 0 — core (`@babylonjs/lite-gl/render-target`)
The 90% case: post-processing, frame feedback, offscreen compositing.

```ts
export interface GLRenderTargetOptions {
    width: number;
    height: number;
    /** Allocate a DEPTH_COMPONENT16 renderbuffer. Default false. */
    generateDepthBuffer?: boolean;
    /** Bring-your-own color attachment (P2's HDR/exotic answer): supply a
     *  GLTexture you made with createRawTexture(... gl.HALF_FLOAT ...) and the
     *  RT just wraps it. When omitted, an RGBA8 color texture is created. */
    colorTexture?: GLTexture;
    minFilter?: GLenum; magFilter?: GLenum; wrapS?: GLenum; wrapT?: GLenum;
}

export interface GLRenderTarget {
    readonly texture: GLTexture;   // sampleable color attachment
    width: number; height: number;
    isReady: boolean;              // parity with GLTexture/theduck
    // @internal _framebuffer, _depthBuffer, _disposed, _restore, _engine
}

createRenderTarget(engine, options): GLRenderTarget   // FBO + (RGBA8 | options.colorTexture) + opt depth16
bindRenderTarget(engine, rt | null): void             // null = canvas; sets viewport to RT/canvas size
resizeRenderTarget(engine, rt, width, height): void   // preserves a live binding
disposeRenderTarget(engine, rt | null | undefined): void
```

Notes: **one** unbind convention — `bindRenderTarget(engine, null)` (drop
`theduck`'s separate `unbindRenderTarget`, one fewer export). `createRenderTarget`
contains **no** HDR/stencil/mipmap branches; it is format-agnostic via
`colorTexture`.

### Tier 1 — opt-in, each tree-shakes to 0 bytes when unused
```ts
// readback (from theduck) — separate export
readRenderTargetPixels(engine, rt, x, y, w, h, into?): ArrayBufferView
// mipmaps — a function, NOT a create option
generateRenderTargetMipMaps(engine, rt): void
// HDR — float / half-float color, two ways (both tree-shake when unused):
//   options.colorTexture = createFloatTexture(engine, null, w, h, …)   // BYO
//   createFloatRenderTarget(engine, { width, height, type? })          // sugar
//   (the float-format table lives only in these, never in the RGBA8 core)
// stencil — generateRenderTargetStencil(engine, rt, { depth? }) from /depth-stencil
//   packs DEPTH24_STENCIL8 (default) or stencil-only STENCIL_INDEX8 (depth:false);
//   opt-in, installs a restore/resize hook so the attachment survives context loss
// ping-pong (from newdemo) — feedback helper
createPingPong(engine, options): GLPingPong            // { read, write, swap() }
resizePingPong(engine, pp, width, height): void
disposePingPong(engine, pp | null | undefined): void
// MRT — future `@babylonjs/lite-gl/render-target-mrt`
```

## 4. Texture API (converged, tiered)

### Tier 0 — core (main barrel)
```ts
export interface GLTextureOptions {
    invertY?: boolean;
    minFilter?: GLenum; magFilter?: GLenum; wrapS?: GLenum; wrapT?: GLenum;
    /** Explicit sized internal format. When omitted the core resolves the LDR
     *  byte formats inline (RGBA→RGBA8, RGB→RGB8, RG→RG8, R→R8, LUMINANCE).
     *  HDR/exotic callers pass this (e.g. gl.RGBA16F) so the float-format table
     *  is NOT in the core path. */
    internalFormat?: GLenum;
}

createRawTexture(engine, data, w, h, format, type, options?): GLTexture
bindTexture(engine, unit, tex | null): void
disposeTexture(engine, tex): void
```

The current `pickSizedInternalFormat` (LDR + FLOAT/HALF_FLOAT branches) is
replaced by: a tiny **inline LDR resolver** in the core + the optional
`internalFormat` passthrough for HDR. The HDR table moves into the opt-in HDR
sugar below, so RGBA8-only consumers stop shipping `RGBA16F/RGBA32F` branches.

### Tier 1 — opt-in, separate exports (most already separate ✓)
```ts
loadTexture2D(engine, url, options?, onLoad?, onError?): GLTexture   // async image (already separate)
updateRawTexture(engine, tex, data, …): void                         // sub-image (theduck)
updateTextureSamplingMode(engine, tex, minFilter, magFilter): void   // (theduck)
updateTextureWrapMode(engine, tex, wrapS, wrapT): void               // (theduck)
createTextureFromHandle(engine, handle, w, h, options?): GLTexture   // interop (theduck)
generateTextureMipMaps(engine, tex): void                            // mipmaps as a fn, not an option
// HDR sugar (knows RGBA16F/32F) — ships in the main barrel; tree-shakes when unused
createFloatTexture(engine, data, w, h, options?): GLTexture
// dynamic (canvas-backed) textures — `@babylonjs/lite-gl/dynamic-texture` (tinylottie)
createDynamicTexture(engine, w, h, options?): GLTexture
updateDynamicTexture(engine, tex, source, invertY?, premultiplyAlpha?): void
clearDynamicTextureSource(tex): void
// HTML-element textures — existing `/html-texture` sub-entry
```

> Resolved (owner): mipmaps are **function-only**. `generateMipMaps` is NOT a
> core create-option on `createRawTexture` / `loadTexture2D` / `createRenderTarget`;
> callers opt in via `generateTextureMipMaps(engine, tex)` /
> `generateRenderTargetMipMaps(engine, rt)`. This keeps the create path
> branch-free (P2) and removes the implicit "auto-regenerate on unbind" behavior.
> (The `/html-texture` and `/dynamic-texture` factories keep their own
> sampling-mode-driven `generateMipMaps` flag — separate opt-in sub-entries.)

## 5. Reconciliation matrix (what each branch does)

| Symbol | newdemo | theduck | tinylottie | Spec action |
|---|---|---|---|---|
| `createRenderTarget` sig | `(e, opts)` | `(e, w, h, opts?)` | — | **adopt `(e, opts)`** (extensible, matches WebGPU-lite Descriptor) |
| `bindRenderTarget(null)` vs `unbindRenderTarget` | null-bind | `unbind` | — | **null-bind**; drop `unbindRenderTarget` |
| `disposeRenderTarget` null-safe | ✓ | ✗ | — | **null-safe** |
| HDR float/half target | ✗ | option `type` | — | **BYO `colorTexture` / `createFloatRenderTarget`** (out of core) |
| stencil | ✗ | option | — | **`generateRenderTargetStencil`** (/depth-stencil), opt-in |
| mipmaps (RT) | ✗ | option | — | **`generateRenderTargetMipMaps`** fn |
| `readRenderTargetPixels` | ✗ | ✓ | — | **keep** (Tier 1) |
| ping-pong | ✓ | ✗ | — | **keep** (Tier 1) |
| `GLRenderTarget.isReady` | ✗ | ✓ | — | **include** |
| `createRawTexture` HDR table | inline | inline | inline | **inline LDR only + `internalFormat`**; HDR → `createFloatTexture` |
| `updateRawTexture` / sampling / wrap / fromHandle | ✗ | ✓ | ✗ | **keep** (Tier 1, separate exports) |
| dynamic textures | ✗ | ✗ | ✓ | **`/dynamic-texture` sub-entry** |
| `mesh` / `depth-stencil` / `scissor` | ✗ | ✓ | ✗ | **keep as separate sub-entries** (already tree-shakeable ✓) |
| `state.boundFramebuffer` | ✓ | ✓ | — | **already identical** ✓ |

## 6. Packaging (exports map)

- main barrel: engine, render-loop, effects, effect-renderer, **texture core**,
  blend.
- `@babylonjs/lite-gl/render-target` — Tier-0 RT + ping-pong + readback +
  `generateRenderTargetMipMaps`.
- `@babylonjs/lite-gl/dynamic-texture` — dynamic (canvas) textures.
- `@babylonjs/lite-gl/mesh`, `/depth-stencil`, `/scissor` — theduck's engine
  expansion (already separate).
- existing: `/sprites`, `/html-texture`.
- HDR sugar (`createFloatTexture` / `createFloatRenderTarget`): ships in the main
  barrel + `/render-target` (they're tiny and tree-shake when unused). No
  separate `/texture-hdr` sub-entry.

All `sideEffects:false`; the lab bundle-size test (`scene-config-webgl.json
maxRawKB`) must show effect-only scenes UNCHANGED after these land (proves the
opt-ins tree-shake).

## 7. Resolved decisions (owner-approved)

1. **RT create shape** — options-object `createRenderTarget(engine, options)`
   (not theduck's positional `w/h`).
2. **HDR ergonomics** — keep **both**: BYO `colorTexture` (format-agnostic core)
   **and** the thin `createFloat*` sugar (tree-shakes when unused).
3. **Mipmaps** — **function-only**. No `generateMipMaps` create-option on the
   core texture/RT path; use `generateTextureMipMaps` /
   `generateRenderTargetMipMaps`. The implicit auto-regenerate-on-unbind is
   removed. (`/html-texture` + `/dynamic-texture` keep their own
   sampling-mode-driven flag.)
4. **Stencil** — **depth-stencil-module opt-in**. Not a `createRenderTarget`
   option; use `generateRenderTargetStencil(engine, rt, { depth? })` from
   `/depth-stencil` (packed DEPTH24_STENCIL8 default, or stencil-only
   STENCIL_INDEX8 with `depth:false`). The core RT keeps only the sanctioned
   `generateDepthBuffer` (DEPTH_COMPONENT16); the helper installs a
   restore/resize hook so the attachment survives FBO rebuilds, and the stencil
   constants stay out of the core bundle.
5. **`mesh`/`depth-stencil`/`scissor`** — ship as separate tree-shakeable
   sub-entries (they don't conflict with this spec).
6. **Merge order** — land the converged core first, then layer theduck's Tier-1
   + tinylottie's dynamic textures on top. Confirmed.

## 8. Expected outcome

- One `createRenderTarget` / `createRawTexture` across all branches → no
  source-incompatible duplicates; merges are textual-only on shared files.
- RGBA8 consumers (the demos, simple post-fx) ship ~minimal FBO/texture code;
  ShadeBuilder/HDR consumers opt into readback/stencil/HDR/mesh and pay only for
  those.
- Absolute savings on lean-vs-fat cores are modest (~0.5–1 KB each), but the
  principle compounds across the whole engine surface and keeps the demos
  genuinely tiny — the entire point of lite-gl.
