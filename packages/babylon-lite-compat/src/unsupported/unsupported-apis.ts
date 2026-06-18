/**
 * Stubs for Babylon.js core/loader APIs that are **known but not supported** by
 * Babylon Lite.
 *
 * Every entry here throws {@link LiteCompatError} on use (construction or call),
 * so a ported scene fails loudly with a clear pointer instead of either a
 * confusing "X is not exported from the compat package" error or, worse, a
 * silently-wrong render. These mirror the `❌ Not supported` /
 * `⛔ Out of scope` rows in `COMPAT-STATUS.md`.
 *
 * As Babylon Lite gains a capability, the corresponding stub here should be
 * replaced by a real wrapper (and its `COMPAT-STATUS.md` row upgraded).
 */

import { unsupported } from "../error.js";

// ─── Materials ───────────────────────────────────────────────────────
export class MultiMaterial {
    public constructor() {
        unsupported("MultiMaterial", "Babylon Lite uses one material per renderable. Split the mesh geometry by material into separate meshes instead.");
    }
}

export class ShaderMaterial {
    public constructor() {
        unsupported("ShaderMaterial", "Babylon Lite is WGSL-only. Use the native `createShaderMaterial` (WGSL) API; there is no automatic GLSL translation.");
    }
}

export class BackgroundMaterial {
    public constructor() {
        unsupported("BackgroundMaterial", "Standalone BackgroundMaterial is not wrapped. Use the compat `Scene` environment helpers / native `loadEnvironment` instead.");
    }
}

// ─── Lights ──────────────────────────────────────────────────────────
export class RectAreaLight {
    public constructor() {
        unsupported("RectAreaLight", "Area lights are not implemented in Babylon Lite. Use Point/Spot/Directional/Hemispheric lights.");
    }
}

export class ClusteredLightContainer {
    public constructor() {
        unsupported("ClusteredLightContainer", "Clustered lighting is not exposed by the Babylon Lite public API; the compat layer cannot wrap it.");
    }
}

// ─── Particles ───────────────────────────────────────────────────────
export class ParticleSystem {
    public constructor() {
        unsupported("ParticleSystem", "Particle systems are not implemented in Babylon Lite.");
    }
}

export class GPUParticleSystem {
    public constructor() {
        unsupported("GPUParticleSystem", "Particle systems are not implemented in Babylon Lite.");
    }
}

export class SolidParticleSystem {
    public constructor() {
        unsupported("SolidParticleSystem", "Solid particle systems are not implemented in Babylon Lite. Consider native thin instances for many-copies use cases.");
    }
}

// ─── Effect layers ───────────────────────────────────────────────────
export class HighlightLayer {
    public constructor() {
        unsupported("HighlightLayer", "Effect layers are not implemented in Babylon Lite.");
    }
}

export class GlowLayer {
    public constructor() {
        unsupported("GlowLayer", "Effect layers are not implemented in Babylon Lite. For a bloom-style glow, use the native bloom post-process task.");
    }
}

// ─── Mesh-attached renderers / projectors ────────────────────────────
export class LinesMesh {
    public constructor() {
        unsupported("LinesMesh", "Line meshes are not implemented in Babylon Lite.");
    }
}

export class GreasedLineMesh {
    public constructor() {
        unsupported("GreasedLineMesh", "Greased-line meshes are not implemented in Babylon Lite.");
    }
}

export class EdgesRenderer {
    public constructor() {
        unsupported("EdgesRenderer", "Edge rendering is not implemented in Babylon Lite.");
    }
}

export class OutlineRenderer {
    public constructor() {
        unsupported("OutlineRenderer", "Mesh outline rendering is not implemented in Babylon Lite.");
    }
}

// ─── Textures ────────────────────────────────────────────────────────
export class MirrorTexture {
    public constructor() {
        unsupported("MirrorTexture", "Mirror/reflection textures are not implemented in Babylon Lite. Build one from a native render-target texture + clip plane if required.");
    }
}

// ─── Audio ───────────────────────────────────────────────────────────
export class Sound {
    public constructor() {
        unsupported("Sound", "Audio is not part of Babylon Lite. Use the Web Audio API directly.");
    }
}

// ─── Serialization ───────────────────────────────────────────────────
/** Babylon.js scene serializer. Babylon Lite uses different data structures and does not round-trip `.babylon`. */
export const SceneSerializer = {
    Serialize(): never {
        return unsupported("SceneSerializer.Serialize", "Babylon Lite does not implement `.babylon` scene serialization.");
    },
    SerializeMesh(): never {
        return unsupported("SceneSerializer.SerializeMesh", "Babylon Lite does not implement mesh serialization.");
    },
};
