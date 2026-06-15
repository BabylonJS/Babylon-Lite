/**
 * Throwing stubs for additional Babylon.js core/loaders symbols that Babylon
 * Lite either does not implement, or exposes only through a different native API
 * that the compat layer does not wrap 1:1.
 *
 * Every stub throws {@link LiteCompatError} on use with a pointer to the native
 * Babylon Lite alternative where one exists. This keeps the completeness
 * invariant — every core/loaders symbol resolves to an import and fails loudly
 * rather than silently.
 */

import { unsupported } from "../error.js";

// ─── Bones / Skeletons / Morph ───────────────────────────────────────
export class Skeleton {
    public constructor() {
        unsupported("Skeleton", "Skeletons are produced by the glTF loader in Babylon Lite and driven by `createAnimationController`; they are not constructed manually.");
    }
}

export class Bone {
    public constructor() {
        unsupported("Bone", "Bones are produced by the glTF loader in Babylon Lite; manual bone construction is not wrapped.");
    }
}

// ─── Probes / Layers / Rendering ─────────────────────────────────────
export class ReflectionProbe {
    public constructor() {
        unsupported("ReflectionProbe", "Dynamic reflection probes are not implemented in Babylon Lite.");
    }
}

export class Layer {
    public constructor() {
        unsupported("Layer", "2D background/foreground layers are not wrapped. Use the native effect-render-task APIs for fullscreen overlays.");
    }
}

export class EffectLayer {
    public constructor() {
        unsupported("EffectLayer", "Effect layers are not implemented in Babylon Lite.");
    }
}

export class DepthRenderer {
    public constructor() {
        unsupported("DepthRenderer", "Use the native linear-depth material / geometry-renderer task instead.");
    }
}

export class GeometryBufferRenderer {
    public constructor() {
        unsupported("GeometryBufferRenderer", "Use the native `createGeometryRendererTask` (G-buffer) API instead.");
    }
}

export class BoundingBoxRenderer {
    public constructor() {
        unsupported("BoundingBoxRenderer", "Bounding-box rendering is not implemented in Babylon Lite.");
    }
}

// ─── Post-processes ──────────────────────────────────────────────────
// The visual effects below exist in Babylon Lite as frame-graph post-process
// tasks (e.g. `createBloomPostProcessTask`), but the Babylon.js camera-attached
// `PostProcess` class model is not wrapped. Use the native task APIs.
export class PostProcess {
    public constructor() {
        unsupported(
            "PostProcess",
            "Babylon Lite uses frame-graph post-process tasks rather than camera-attached PostProcess objects. Use the native `create*PostProcessTask` APIs."
        );
    }
}

function postProcessStub(name: string, nativeTask: string): { new (): never } {
    return class {
        public constructor() {
            unsupported(name, `Use the native \`${nativeTask}\` frame-graph task instead of the Babylon.js PostProcess class.`);
        }
    } as unknown as { new (): never };
}

export const BlackAndWhitePostProcess = postProcessStub("BlackAndWhitePostProcess", "createBlackAndWhitePostProcessTask");
export const BlurPostProcess = postProcessStub("BlurPostProcess", "createBlurPostProcessTask");
export const BloomEffect = postProcessStub("BloomEffect", "createBloomPostProcessTask");
export const ChromaticAberrationPostProcess = postProcessStub("ChromaticAberrationPostProcess", "createChromaticAberrationPostProcessTask");
export const DepthOfFieldEffect = postProcessStub("DepthOfFieldEffect", "createDepthOfFieldPostProcessTask");

export class DefaultRenderingPipeline {
    public constructor() {
        unsupported(
            "DefaultRenderingPipeline",
            "Compose the native frame-graph post-process tasks (bloom, depth-of-field, chromatic aberration, image processing) instead of the Babylon.js DefaultRenderingPipeline."
        );
    }
}

export class FxaaPostProcess {
    public constructor() {
        unsupported("FxaaPostProcess", "FXAA is not implemented in Babylon Lite.");
    }
}

export class SSAO2RenderingPipeline {
    public constructor() {
        unsupported("SSAO2RenderingPipeline", "SSAO is not implemented in Babylon Lite.");
    }
}

// ─── Particles ───────────────────────────────────────────────────────
export class ParticleHelper {
    public constructor() {
        unsupported("ParticleHelper", "Particle systems are not implemented in Babylon Lite.");
    }
}

export class ParticleSystemSet {
    public constructor() {
        unsupported("ParticleSystemSet", "Particle systems are not implemented in Babylon Lite.");
    }
}

export class PointsCloudSystem {
    public constructor() {
        unsupported("PointsCloudSystem", "Point-cloud systems are not implemented in Babylon Lite. For Gaussian splats use the native splat loaders.");
    }
}

// ─── Physics ─────────────────────────────────────────────────────────
// Babylon Lite ships a Havok-V2 subset via `createHavokWorld` /
// `createPhysicsAggregate` etc. The Babylon.js plugin/aggregate class model is
// not wrapped 1:1; use the native physics functions.
export class HavokPlugin {
    public constructor() {
        unsupported("HavokPlugin", "Use the native `createHavokWorld` API; the Babylon.js physics-plugin object is not wrapped.");
    }
}

export class PhysicsAggregate {
    public constructor() {
        unsupported("PhysicsAggregate", "Use the native `createPhysicsAggregate` API instead of the Babylon.js PhysicsAggregate class.");
    }
}

export class PhysicsBody {
    public constructor() {
        unsupported("PhysicsBody", "Use the native `createPhysicsBody` API.");
    }
}

export class PhysicsShape {
    public constructor() {
        unsupported("PhysicsShape", "Use the native `createPhysicsShape` API.");
    }
}

export class CannonJSPlugin {
    public constructor() {
        unsupported("CannonJSPlugin", "Babylon Lite physics is Havok-V2 only.");
    }
}

export class AmmoJSPlugin {
    public constructor() {
        unsupported("AmmoJSPlugin", "Babylon Lite physics is Havok-V2 only.");
    }
}

// ─── Navigation ──────────────────────────────────────────────────────
export class RecastJSPlugin {
    public constructor() {
        unsupported("RecastJSPlugin", "Use the native Recast-V2 navigation API (`createNavigationPluginAsync`, `createNavMesh`, `createNavCrowd`).");
    }
}

// ─── Audio ───────────────────────────────────────────────────────────
export class AudioEngine {
    public constructor() {
        unsupported("AudioEngine", "Audio is not part of Babylon Lite. Use the Web Audio API directly.");
    }
}

export class WeightedSound {
    public constructor() {
        unsupported("WeightedSound", "Audio is not part of Babylon Lite.");
    }
}

// ─── Loaders (formats not present in Babylon Lite) ───────────────────
export class OBJFileLoader {
    public constructor() {
        unsupported("OBJFileLoader", "The OBJ format is not supported by Babylon Lite. Convert to glTF.");
    }
}

export class STLFileLoader {
    public constructor() {
        unsupported("STLFileLoader", "The STL format is not supported by Babylon Lite. Convert to glTF.");
    }
}

export class FBXFileLoader {
    public constructor() {
        unsupported("FBXFileLoader", "The FBX format is not supported by Babylon Lite. Convert to glTF.");
    }
}

export class BVHFileLoader {
    public constructor() {
        unsupported("BVHFileLoader", "The BVH format is not supported by Babylon Lite.");
    }
}

// ─── Sprites ─────────────────────────────────────────────────────────
// `SpriteManager` / `Sprite` are wrapped over Lite's facing-billboard system
// (see ../sprites/sprites.ts). `SpriteMap` / `SpritePackedManager` remain
// unsupported (tile-map / packed-atlas variants are not wrapped).
export class SpriteMap {
    public constructor() {
        unsupported("SpriteMap", "Tile-map sprites are not wrapped; use the native sprite APIs.");
    }
}

export class SpritePackedManager {
    public constructor() {
        unsupported("SpritePackedManager", "Use the native Babylon Lite sprite APIs.");
    }
}

// ─── Misc (device / optimisation surfaces not wrapped) ───────────────
export class VirtualJoystick {
    public constructor() {
        unsupported("VirtualJoystick", "The virtual joystick UI is not part of Babylon Lite.");
    }
}

export class SceneOptimizer {
    public constructor() {
        unsupported("SceneOptimizer", "Automatic scene optimisation is not implemented in the compat layer.");
    }
}
