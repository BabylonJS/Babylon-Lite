# Lite-GL browser/native client integration

The supported client pattern is **one shared visual implementation plus two tiny
platform bootstrap files**. Do not branch throughout rendering code and do not
maintain separate effect implementations.

## Package selection

`@babylonjs/lite-gl` defaults to the WebGL barrel. The package also exposes:

- `@babylonjs/lite-gl/native` for explicit native engine creation.
- A `babylon-native` export condition that maps bare internal imports such as
  `@babylonjs/lite-gl` to the native barrel.

For a webpack BabylonNative build:

```js
resolve: {
    conditionNames: ["babylon-native", "..."],
}
```

Browser builds require no condition or alias. The explicit `/native` subpath
remains the portable fallback for tools that do not support custom conditions.

## Shared visual configuration

```ts
import type { MyEffect } from "my-visuals";

export function configureEffect(effect: MyEffect): void {
    effect.setDarkMode(false);
    effect.setIntensity(1);
    effect.start((error) => console.error(error));
}
```

## Browser bootstrap

```ts
import { MyEffect } from "my-visuals";
import { configureEffect } from "./configureEffect";

const canvas = document.querySelector("canvas");
if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("render canvas not found");
}

configureEffect(new MyEffect(canvas));
```

## BabylonNative bootstrap

```ts
import { createNativeGLEngine } from "@babylonjs/lite-gl/native";
import { MyEffect } from "my-visuals";
import { configureEffect } from "./configureEffect";

configureEffect(new MyEffect(createNativeGLEngine()));
```

`createGLEngine(null)` from the bare `@babylonjs/lite-gl` import (resolved to the
native barrel through the `babylon-native` condition) is equivalent; the canvas
argument is ignored on Native.

The effect and all renderer calls remain identical. Only device creation belongs
in the platform bootstrap.

## Shared rendering code (receiver-first API)

Both barrels expose the same receiver-first API: functions that act on a
resource take the resource first and reach its engine through the resource, so
shared code never threads the engine through resource calls:

```ts
import {
    bindRenderTarget,
    bindTexture,
    createEffect,
    createRenderTarget,
    getEffectCompilationError,
    restoreDefaultFramebuffer,
    setEffectFloat4,
    unbindTexture,
    waitForEffect,
    type GLEngineContext,
    type GLTexture,
} from "@babylonjs/lite-gl";

export async function prepare(engine: GLEngineContext, vertexSource: string, fragmentSource: string) {
    // Never throws on shader errors: await readiness or poll getEffectCompilationError.
    const effect = createEffect(engine, { name: "tint", vertexSource, fragmentSource, uniformNames: ["uTint"], samplerNames: ["uTex"] });
    await waitForEffect(effect).catch(() => {
        throw new Error(getEffectCompilationError(effect) ?? "tint effect failed");
    });
    const target = createRenderTarget(engine, 256, 256);
    return { effect, target };
}

export function drawInto(engine: GLEngineContext, prepared: Awaited<ReturnType<typeof prepare>>, tex: GLTexture): void {
    bindRenderTarget(prepared.target); // engine comes from the render target
    setEffectFloat4(prepared.effect, "uTint", 1, 1, 1, 1);
    bindTexture(tex, 0); // engine comes from the texture
    // ... draw ...
    unbindTexture(engine, 0); // unbinds take the engine
    restoreDefaultFramebuffer(engine);
}
```

Features Babylon Native cannot back keep their names and signatures but are
gated by capability flags; check them before using the feature in shared code:
`engine.caps.alphaToCoverage`, `separateStencil`, `textRendering` (all `false`
on Native), plus `texture3D` and `gpuFrameTime` (host-dependent). `readRenderTargetPixels` /
`readRenderTargetPixelsToBuffer` return a `Promise` on Native, so shared code
should `await` their result (awaiting a WebGL return value is harmless).
`getRenderingCanvas` throws on Native; use `getRenderWidth` / `getRenderHeight`.
See [03-native-backend.md](03-native-backend.md) §3 for the full table.

## Why dependency injection is the boundary

A shared effect that accepts either a browser canvas or a pre-created
`GLEngineContext` gets a stable native integration boundary by receiving a context:

- The visual library remains unaware of BabylonNative host setup.
- Lite-gl owns WebGL/native device semantics and command encoding.
- Client apps keep platform selection at the composition root.
- Tests can inject a mock context without DOM or native globals.

Avoid runtime environment detection inside the visual. Build-time package
selection is deterministic, tree-shakeable, and prevents both backends from
shipping in the same bundle.
