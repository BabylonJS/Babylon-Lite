/**
 * Morph Target Fragment (shared core)
 *
 * Vertex-stage morph target animation: storage-buffer position/normal deltas
 * applied before skinning. Consumed by both the PBR morph extension
 * (material/pbr/fragments/morph-fragment.ts) and the Standard material
 * renderable. Only bundled when a scene uses morph targets.
 *
 * The deltas and weights live in read-only storage buffers (no uniforms, no
 * texture atlas) so the layout grows past the old vec4 (4-target) limit.
 *
 * To keep the shared `shader-composer.ts` free of any storage-buffer support
 * (so non-morph scenes pay zero bytes for it), the bindings are declared as
 * placeholder `uniform-buffer` entries and a `_postCompose` step rewrites the
 * two emitted decls (and their BGL entries) from `uniform` to read-only
 * `storage` after composition. The composer never learns about storage buffers.
 */

import type { ComposedShader, ShaderFragment } from "../fragment-types.js";

// WebGPU shader stage constants
const STAGE_VERTEX = 0x1;

const MORPH_PRE_SKINNING = `var morphedPos = position;
var morphedNorm = normal;
for (var i = 0u; i < morph.count; i = i + 1u) {
  let w = morph.weights[i];
  let b = (i * morph.vertexCount + vertexIndex) * 6u;
  morphedPos = morphedPos + w * vec3<f32>(morphDeltas.d[b], morphDeltas.d[b + 1u], morphDeltas.d[b + 2u]);
  morphedNorm = morphedNorm + w * vec3<f32>(morphDeltas.d[b + 3u], morphDeltas.d[b + 4u], morphDeltas.d[b + 5u]);
}`;

/** Rewrite the morph/morphDeltas `var<uniform>` placeholders to read-only `var<storage, read>`,
 *  and flip their mesh-BGL entries from `uniform` to `read-only-storage`. Invoked by the PBR and
 *  Standard pipelines after composition (never by the generic composer).
 *
 *  The two morph bindings are declared as `uniform-buffer` placeholders so the shared
 *  `shader-composer.ts` needs no storage-buffer support (keeping non-morph scenes byte-identical).
 *  The rewrite is anchored on the unique binding names (`morphDeltas`, `morph`) and asserts both were
 *  found, so any future change to the composer's decl format fails loudly here rather than silently
 *  shipping a wrong address space. */
function patchMorphStorage(composed: ComposedShader): ComposedShader {
    const morphBindings = new Set<number>();
    let rewrites = 0;
    const vertexWGSL = composed._vertexWGSL.replace(/@group\(1\)@binding\((\d+)\) var<uniform> (morphDeltas|morph):/g, (_match, num: string, name: string) => {
        morphBindings.add(Number(num));
        rewrites++;
        return `@group(1)@binding(${num}) var<storage, read> ${name}:`;
    });
    // The morph fragment always contributes exactly two vertex bindings (deltas + weights).
    // Anything else means the composer's decl format drifted from what this rewrite expects.
    if (rewrites !== 2) {
        throw new Error(`morph _postCompose: expected to rewrite 2 binding declarations, rewrote ${rewrites}`);
    }
    const entries = (composed._meshBGLDescriptor.entries as GPUBindGroupLayoutEntry[]).map((e) =>
        morphBindings.has(e.binding) ? { ...e, buffer: { type: "read-only-storage" as const } } : e
    );
    return { ...composed, _vertexWGSL: vertexWGSL, _meshBGLDescriptor: { ...composed._meshBGLDescriptor, entries } };
}

/**
 * Create a morph target fragment.
 * The morph extension modifies position/normal variables before the world
 * transform, using morphedPos/morphedNorm in place of position/normal.
 */
export function createMorphFragment(): ShaderFragment {
    return {
        _id: "morph",

        _vertexBuiltins: [{ _name: "vertexIndex", _builtin: "vertex_index", _type: "u32" }],

        _vertexHelperFunctions: `struct morphUniforms {\ncount: u32,\nvertexCount: u32,\n_p0: u32,\n_p1: u32,\nweights: array<f32>,\n}\nstruct morphDeltasUniforms {\nd: array<f32>,\n}`,

        // Declared as uniform-buffer placeholders; `_postCompose` rewrites them to storage.
        _vertexBindings: [
            { _name: "morphDeltas", _type: { _kind: "uniform-buffer" as const }, _visibility: STAGE_VERTEX },
            { _name: "morph", _type: { _kind: "uniform-buffer" as const }, _visibility: STAGE_VERTEX },
        ],

        _vertexSlots: {
            VR: MORPH_PRE_SKINNING,
        },

        _pc: patchMorphStorage,
    };
}
