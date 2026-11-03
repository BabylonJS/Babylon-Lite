/** Optional PBR geometry-pass velocity: per-mesh previous-world reprojection and its vertex WGSL.
 *
 *  Installed only by the explicit `enableGeometryVelocity` enabler, so ordinary PBR geometry passes
 *  never retain the matrix inversion, deformation hooks or velocity shader code. */

import { F32 } from "../../engine/typed-arrays.js";
import type { EngineContext } from "../../engine/engine.js";
import type { Mesh } from "../../mesh/mesh.js";
import { createUniformBuffer } from "../../resource/uniform-buffer.js";
import type { BindingDecl, ShaderFragment, Varying } from "../../shader/fragment-types.js";
import { wgsl, type WgslSource } from "../../shader/wgsl.js";
import { createIdentityMat4 } from "../../math/create-identity-mat4.js";
import { invertMat4ToRefOrIdentity } from "../../math/invert-mat4-to-ref-or-identity.js";
import { multiplyMat4IntoBuffer } from "../../math/multiply-mat4-into-buffer.js";
import { mat4Determinant3 } from "../../math/mat4-determinant3.js";
import type { Mat4, Mat4Storage } from "../../math/types.js";
import { MSH_HAS_MORPH_TARGETS, MSH_HAS_SKELETON, MSH_HAS_THIN_INSTANCES, MSH_VAT } from "../mesh-features.js";
import { getGeometryDeformationVelocity } from "../geometry-deformation-hooks.js";
import type { GeometryDeformationVelocity } from "../geometry-deformation-velocity.js";
import type { PbrGeometryMaterialView } from "./pbr-geometry-view.js";

const STAGE_VERTEX = 0x1;
let activeView: PbrGeometryMaterialView | null = null;

/** @internal Scope feature generation to the current task's material view, including nested composition. */
export function setActiveGeometryVelocityView(view: PbrGeometryMaterialView | null): PbrGeometryMaterialView | null {
    const previous = activeView;
    activeView = view;
    return previous;
}

/** @internal Separate opted-in and historical shaders in the shared scene composer cache. */
export function geometryVelocityKey(): string {
    return activeView?._geometryVelocity ? ":material-point-velocity" : "";
}

/** @internal Previous-depth output is part of the explicit producer feature, not ordinary geometry shaders. */
export function geometryVelocityOutput(alpha: string): WgslSource {
    return wgsl`vec4<f32>(0.5 * ((input.vPreviousClip.xy / input.vPreviousClip.w) - (input.vCurrentClip.xy / input.vCurrentClip.w)), select(0.0, input.vPreviousClip.w, gp.cameraNearFar.z > 0.5), ${alpha})`;
}

/** @internal Replace the historical camera-only contribution at an explicit feature boundary. */
export function extendPbrGeometryParams(fragment: ShaderFragment, meshFeatures: number, localPosition: boolean): ShaderFragment {
    if (!activeView?._geometryVelocity) {
        return fragment;
    }
    const velocity = pbrGeometryVelocityShader(meshFeatures);
    const helpers = wgsl`${fragment._helperFunctions!}\n${velocity.helpers}`;
    return {
        ...fragment,
        _bindings: [...fragment._bindings!, ...velocity.bindings],
        _helperFunctions: helpers,
        _vertexHelperFunctions: helpers,
        _vertexSlots: { VB: wgsl`${velocity.vertex}\n${localPosition ? "out.vLocalPos = position;" : ""}` },
        _pc: velocity.patch,
    };
}

/** @internal Resource bindings owned by the opted-in geometry velocity feature. */
export function bindPbrGeometryVelocity(view: PbrGeometryMaterialView, entries: GPUBindGroupEntry[], binding: number): number {
    if (view._previousWorldUBO) {
        entries.push({ binding: binding++, resource: { buffer: view._previousWorldUBO } });
    }
    return view._deformationVelocity?._bind(entries, binding) ?? binding;
}

/** Vertex-stage velocity contribution appended to the PBR geometry-params fragment. */
export interface PbrGeometryVelocityShader {
    readonly bindings: BindingDecl[];
    readonly helpers: WgslSource;
    readonly varyings: Varying[];
    readonly vertex: string;
    readonly patch: ShaderFragment["_pc"];
}

/** Build the velocity bindings, helpers, varyings and vertex code for one mesh variant. */
export function pbrGeometryVelocityShader(meshFeatures: number): PbrGeometryVelocityShader {
    const hasDeformation = !(meshFeatures & (MSH_HAS_THIN_INSTANCES | MSH_VAT)) && (meshFeatures & (MSH_HAS_SKELETON | MSH_HAS_MORPH_TARGETS)) !== 0;
    const feature = hasDeformation ? getGeometryDeformationVelocity() : null;
    if (hasDeformation && !feature) {
        throw new Error("PBR geometry deformation velocity was not preloaded.");
    }
    const deformation = feature?.geometryPreviousDeformation(meshFeatures);
    const bindings: BindingDecl[] = [{ _name: "gm", _type: { _kind: "uniform-buffer" }, _visibility: STAGE_VERTEX }];
    let helpers = wgsl`struct gmUniforms { previousFromCurrent:mat4x4f,enabled:f32,p0:f32,p1:f32,p2:f32 };`;
    const vertex: string[] = [wgsl`out.vCurrentClip = scene.viewProjection * vec4<f32>(out.worldPos, 1.0);`];
    if (deformation) {
        bindings.push(...deformation.bindings);
        if (meshFeatures & MSH_HAS_MORPH_TARGETS) {
            helpers = wgsl`${helpers}\n${feature!.PREVIOUS_MORPH_WGSL}`;
        }
        vertex.push(deformation.code);
    }
    const previousPosition = deformation ? "(mesh.world * vec4f(previousDeformedPosition, 1))" : "vec4f(out.worldPos, 1)";
    vertex.push(wgsl`let previousWorldPos = gm.previousFromCurrent * ${previousPosition};
let trackedPreviousClip = gp.previousViewProjection * previousWorldPos;
out.vPreviousClip = select(out.vCurrentClip, trackedPreviousClip, gm.enabled > 0.5);`);
    return {
        bindings,
        helpers,
        varyings: [
            { _name: "vCurrentClip", _type: "vec4<f32>" },
            { _name: "vPreviousClip", _type: "vec4<f32>" },
        ],
        vertex: vertex.join("\n"),
        patch: deformation?.patch,
    };
}

/** Per-mesh previous-world state backing the `gm` uniform and optional deformation history. */
export interface PbrGeometryVelocity {
    /** @internal */
    readonly _previousWorldUBO: GPUBuffer;
    /** @internal */
    readonly _deformationVelocity: GeometryDeformationVelocity | null;
    /** @internal Advance after the mesh UBO world was repacked; `worldChanged` mirrors the renderable's check. */
    _update(worldChanged: boolean): void;
    /** @internal */
    _dispose(): void;
}

/** Create one mesh's velocity state. `currentWorld` aliases the packed world in the mesh UBO data. */
export function createPbrGeometryVelocity(engine: EngineContext, mesh: Mesh, currentWorld: Float32Array, exclusions: ReadonlySet<Mesh> | undefined): PbrGeometryVelocity {
    const tracked = (): boolean => mesh.visible !== false && !exclusions?.has(mesh);
    let singularWorld = Math.abs(mat4Determinant3(currentWorld)) < 1e-10;
    if (singularWorld && tracked()) {
        throw new Error("PBR geometry velocity cannot reproject a singular world transform.");
    }
    const needsDeformation = !mesh.thinInstances && !mesh.vat && (!!mesh.skeleton || !!mesh.morphTargets);
    const deformationFeature = needsDeformation ? getGeometryDeformationVelocity() : null;
    if (needsDeformation && !deformationFeature) {
        throw new Error("PBR geometry deformation velocity was not preloaded.");
    }
    const device = engine._device;
    const previousWorld = new F32(currentWorld);
    const inverseWorld = createIdentityMat4();
    const data = new F32(20);
    data[0] = data[5] = data[10] = data[15] = 1;
    const previousWorldUBO = createUniformBuffer(engine, data);
    let deformationVelocity: GeometryDeformationVelocity | null;
    try {
        deformationVelocity = deformationFeature?.createGeometryDeformationVelocity(engine, mesh) ?? null;
    } catch (error) {
        previousWorldUBO.destroy();
        throw error;
    }
    let ready = false;
    let previousMotion = false;
    return {
        _previousWorldUBO: previousWorldUBO,
        _deformationVelocity: deformationVelocity,
        _update(worldChanged: boolean): void {
            if (worldChanged) {
                singularWorld = Math.abs(mat4Determinant3(currentWorld)) < 1e-10;
            }
            const isTracked = tracked();
            if (isTracked && singularWorld) {
                throw new Error("PBR geometry velocity cannot reproject a singular world transform.");
            }
            const enabled = ready && isTracked;
            deformationVelocity?._update(!enabled);
            if (worldChanged || previousMotion || data[16] !== (enabled ? 1 : 0)) {
                if (worldChanged && enabled) {
                    invertMat4ToRefOrIdentity(currentWorld as unknown as Mat4, inverseWorld);
                    multiplyMat4IntoBuffer(data, 0, previousWorld, 0, inverseWorld as unknown as Mat4Storage, 0);
                } else {
                    data.fill(0);
                    data[0] = data[5] = data[10] = data[15] = 1;
                }
                data[16] = enabled ? 1 : 0;
                device.queue.writeBuffer(previousWorldUBO, 0, data as Float32Array<ArrayBuffer>);
            }
            if (worldChanged) {
                previousWorld.set(currentWorld);
            }
            ready = isTracked;
            previousMotion = worldChanged && enabled;
        },
        _dispose(): void {
            previousWorldUBO.destroy();
            deformationVelocity?._dispose();
            deformationVelocity = null;
        },
    };
}
