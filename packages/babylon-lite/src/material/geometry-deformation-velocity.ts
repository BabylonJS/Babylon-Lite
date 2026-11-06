import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import { BU, TU } from "../engine/gpu-flags.js";
import { F32 } from "../engine/typed-arrays.js";
import { createMappedBuffer } from "../resource/mapped-buffer.js";
import type { BindingDecl } from "../shader/fragment-types.js";
import { wgsl, type WgslSource } from "../shader/wgsl.js";
import { makeBoneInfluenceCode } from "../shader/fragments/skeleton-fragment.js";
import { createReadOnlyStorageBinding } from "../shader/read-only-storage-binding.js";
import { MSH_HAS_MORPH_TARGETS, MSH_HAS_SKELETON, MSH_HAS_SKELETON_8, MSH_HAS_THIN_INSTANCES, MSH_VAT } from "./mesh-features.js";

/** @internal Previous-pose state owned by one geometry renderable, not the mesh/material. */
export interface GeometryDeformationVelocity {
    /** @internal Append the same previous-pose resources described by the shader feature. */
    _bind(entries: GPUBindGroupEntry[], binding: number): number;
    /** @internal Publish prior pose and advance the snapshot; neutral initializes to current pose. */
    _update(neutral: boolean): void;
    /** @internal Release only this renderable's previous-pose resources. */
    _dispose(): void;
}

/** @internal Geometry-only previous deformation, applied before previous mesh world. */
export function geometryPreviousDeformation(meshFeatures: number): { bindings: BindingDecl[]; code: WgslSource } | null {
    if (meshFeatures & (MSH_HAS_THIN_INSTANCES | MSH_VAT) || !(meshFeatures & (MSH_HAS_SKELETON | MSH_HAS_MORPH_TARGETS))) {
        return null;
    }
    const bindings: BindingDecl[] = [];
    let code = wgsl`var previousDeformedPosition=position;`;
    if (meshFeatures & MSH_HAS_SKELETON) {
        bindings.push({ _name: "previousBoneSampler", _type: { _kind: "texture", _textureType: "texture_2d<f32>", _sampleType: "unfilterable-float" }, _visibility: 1 });
    }
    const morph = (meshFeatures & MSH_HAS_MORPH_TARGETS) !== 0;
    if (morph) {
        bindings.push(createReadOnlyStorageBinding("previousMorph", 1));
        code = wgsl`${code}
for(var i=0u;i<morph.count;i++){
let b=(i*morph.vertexCount+vertexIndex)*6u;
previousDeformedPosition+=previousMorph.weights[i]*vec3f(morphDeltas.d[b],morphDeltas.d[b+1u],morphDeltas.d[b+2u]);
}`;
    }
    if (meshFeatures & MSH_HAS_SKELETON) {
        code = wgsl`${code}
${makeBoneInfluenceCode((meshFeatures & MSH_HAS_SKELETON_8) !== 0, "previousBoneSampler", "previousInfluence")}
previousDeformedPosition=(previousInfluence*vec4f(previousDeformedPosition,1)).xyz;`;
    }
    return {
        bindings,
        code,
    };
}

/** @internal WGSL struct for the optional previous morph storage binding. */
export const PREVIOUS_MORPH_WGSL = wgsl`struct previousMorphUniforms{weights:array<f32>}`;

/** @internal Snapshot live CPU pose mirrors; all GPU allocations are private and static. */
export function createGeometryDeformationVelocity(engine: EngineContext, mesh: Mesh, skinEnabled = true): GeometryDeformationVelocity {
    const device = engine._device,
        sourceSkeleton = mesh.skeleton,
        skeleton = skinEnabled ? sourceSkeleton : null,
        morph = mesh.morphTargets;
    if ((!skeleton && !morph) || mesh.thinInstances || mesh.vat) {
        throw new Error("Geometry deformation velocity requires a non-instanced live skeleton or morph mesh.");
    }
    if (skeleton && (!Number.isInteger(skeleton.boneCount) || skeleton.boneCount < 1 || skeleton.boneMatrices.length !== skeleton.boneCount * 16)) {
        throw new Error("Invalid geometry velocity bone matrices.");
    }
    if (morph && (!Number.isInteger(morph.count) || morph.count < 1 || morph.weights.length !== morph.count)) {
        throw new Error("Invalid geometry velocity morph weights.");
    }
    const boneSnapshot = skeleton ? new F32(skeleton.boneMatrices) : null;
    const morphSnapshot = morph ? new F32(morph.weights) : null;
    const previousBones = skeleton
        ? device.createTexture({
              label: "geometry-previous-bones",
              size: [skeleton.boneCount * 4, 1],
              format: "rgba32float",
              usage: TU.TEXTURE_BINDING | TU.COPY_DST,
          })
        : null;
    const previousMorph = morphSnapshot ? createMappedBuffer(engine, morphSnapshot, BU.STORAGE) : null;
    const boneView = previousBones?.createView();
    let disposed = false;
    return {
        _bind(entries, binding) {
            if (boneView) {
                entries.push({ binding: binding++, resource: boneView });
            }
            if (previousMorph) {
                entries.push({ binding: binding++, resource: { buffer: previousMorph } });
            }
            return binding;
        },
        _update(neutral) {
            if (disposed || skeleton?._disposed || morph?._disposed) {
                throw new Error("Geometry deformation velocity cannot use disposed pose resources.");
            }
            if (mesh.skeleton !== sourceSkeleton || mesh.morphTargets !== morph) {
                throw new Error("Geometry deformation source changed; rebuild its geometry renderable.");
            }
            if (skeleton) {
                if (neutral) {
                    boneSnapshot!.set(skeleton.boneMatrices);
                }
                device.queue.writeTexture({ texture: previousBones! }, boneSnapshot!, { bytesPerRow: skeleton.boneCount * 64 }, [skeleton.boneCount * 4, 1]);
                boneSnapshot!.set(skeleton.boneMatrices);
            }
            if (morph) {
                if (neutral) {
                    morphSnapshot!.set(morph.weights);
                }
                device.queue.writeBuffer(previousMorph!, 0, morphSnapshot!);
                morphSnapshot!.set(morph.weights);
            }
        },
        _dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            previousBones?.destroy();
            previousMorph?.destroy();
        },
    };
}
