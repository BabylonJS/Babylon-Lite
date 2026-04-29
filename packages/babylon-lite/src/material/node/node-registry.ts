/** Node-block registry — lazy-init dispatch table.
 *
 *  Each block lives in its own module under `./blocks/`. The table maps the
 *  BJS `className` (plus an optional discriminator like `_uniform`/`_attribute`
 *  for InputBlocks) to a dynamic-import loader. Rollup analyzes each literal
 *  `import()` and emits one chunk per block, so scenes only pay for blocks
 *  their snippet actually uses.
 *
 *  GUIDANCE §4: the table itself is built lazily — there is no module-level
 *  `Map` allocation, which would defeat tree-shaking for scenes that never
 *  touch NME at all.
 */

import type { BlockEmitter } from "./node-types.js";

export type BlockLoader = () => Promise<{ emitter: BlockEmitter }>;

let _table: Map<string, BlockLoader> | null = null;

function getTable(): Map<string, BlockLoader> {
    if (_table) {
        return _table;
    }
    const t = new Map<string, BlockLoader>();
    t.set("InputBlock", () => import("./blocks/input-block.js"));
    t.set("VectorMergerBlock", () => import("./blocks/vector-merger.js"));
    t.set("FragmentOutputBlock", () => import("./blocks/fragment-output.js"));
    // Math blocks (phase 1a):
    t.set("AddBlock", () => import("./blocks/add-block.js"));
    t.set("SubtractBlock", () => import("./blocks/subtract-block.js"));
    t.set("MultiplyBlock", () => import("./blocks/multiply-block.js"));
    t.set("MinBlock", () => import("./blocks/min-block.js"));
    t.set("MaxBlock", () => import("./blocks/max-block.js"));
    t.set("PowBlock", () => import("./blocks/pow-block.js"));
    t.set("StepBlock", () => import("./blocks/step-block.js"));
    t.set("DotBlock", () => import("./blocks/dot-block.js"));
    t.set("ScaleBlock", () => import("./blocks/scale-block.js"));
    t.set("OneMinusBlock", () => import("./blocks/oneminus-block.js"));
    t.set("NegateBlock", () => import("./blocks/negate-block.js"));
    t.set("NormalizeBlock", () => import("./blocks/normalize-block.js"));
    t.set("LerpBlock", () => import("./blocks/lerp-block.js"));
    t.set("ClampBlock", () => import("./blocks/clamp-block.js"));
    t.set("SmoothStepBlock", () => import("./blocks/smoothstep-block.js"));
    t.set("RemapBlock", () => import("./blocks/remap-block.js"));
    t.set("TrigonometryBlock", () => import("./blocks/trigonometry-block.js"));
    t.set("VectorSplitterBlock", () => import("./blocks/vector-splitter.js"));
    t.set("ColorSplitterBlock", () => import("./blocks/color-splitter.js"));
    t.set("TransformBlock", () => import("./blocks/transform-block.js"));
    t.set("VertexOutputBlock", () => import("./blocks/vertex-output.js"));
    // Texture + utility blocks (phase 1b):
    t.set("TextureBlock", () => import("./blocks/texture-block.js"));
    t.set("ImageSourceBlock", () => import("./blocks/image-source.js"));
    t.set("FrontFacingBlock", () => import("./blocks/front-facing.js"));
    t.set("ViewDirectionBlock", () => import("./blocks/view-direction.js"));
    // Lighting blocks (phase 1c):
    t.set("LightBlock", () => import("./blocks/light-block.js"));
    t.set("LightInformationBlock", () => import("./blocks/light-information.js"));
    t.set("FogBlock", () => import("./blocks/fog-block.js"));
    t.set("PerturbNormalBlock", () => import("./blocks/perturb-normal.js"));
    // Vertex-transform blocks (phase 1d):
    t.set("BonesBlock", () => import("./blocks/bones-block.js"));
    t.set("InstancesBlock", () => import("./blocks/instances-block.js"));
    t.set("MorphTargetsBlock", () => import("./blocks/morph-targets.js"));
    // Shadow (phase 1e):
    t.set("ShadowMapBlock", () => import("./blocks/shadow-map.js"));
    // Scene 66 additions:
    t.set("DiscardBlock", () => import("./blocks/discard-block.js"));
    t.set("ReflectionTextureBlock", () => import("./blocks/reflection-texture-block.js"));
    // PBR blocks (scene 67+):
    t.set("PBRMetallicRoughnessBlock", () => import("./blocks/pbr-metallic-roughness-block.js"));
    t.set("ReflectionBlock", () => import("./blocks/reflection-block.js"));
    t.set("ClearCoatBlock", () => import("./blocks/clearcoat-block.js"));
    t.set("SheenBlock", () => import("./blocks/sheen-block.js"));
    t.set("AnisotropyBlock", () => import("./blocks/anisotropy-block.js"));
    t.set("SubSurfaceBlock", () => import("./blocks/subsurface-block.js"));
    t.set("RefractionBlock", () => import("./blocks/refraction-block.js"));
    // Each entry MUST use a literal string import so Rollup splits per-block chunks.
    _table = t;
    return t;
}

/** Resolve a block emitter by key. Throws if the block is not registered. */
export async function loadBlockEmitter(key: string): Promise<BlockEmitter> {
    const loader = getTable().get(key);
    if (!loader) {
        throw new Error(`NodeMaterial: no emitter registered for block "${key}"`);
    }
    const mod = await loader();
    return mod.emitter;
}

/** Returns true if a key is registered (used by tests). */
export function hasBlockEmitter(key: string): boolean {
    return getTable().has(key);
}
