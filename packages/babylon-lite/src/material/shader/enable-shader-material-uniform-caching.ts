import { F32, I32, U32, U8 } from "../../engine/typed-arrays.js";
import { getEffectiveAspectRatio, getProjectionMatrix, getViewMatrix, getViewProjectionMatrix } from "../../camera/camera.js";
import { mat4MultiplyInto } from "../../math/mat4-multiply-into.js";
import type { UboSpec } from "../../shader/fragment-types.js";
import type { ShaderMaterial, ShaderUniformSlot } from "./shader-material.js";
import { _isShaderSystemUniform } from "./shader-material.js";
import { _installShaderUniformWriters, type ShaderCustomUniformWriter, type ShaderSystemUniformWriter } from "./shader-renderable.js";

interface CustomWritePlan {
    readonly data: ArrayBuffer;
    readonly size: number;
    readonly f32: Float32Array;
    readonly u32: Uint32Array;
    readonly i32: Int32Array;
    readonly slots: readonly ShaderUniformSlot[];
    readonly indices: Int32Array;
    readonly kinds: Uint8Array;
    readonly lengths: Int32Array;
    readonly versions: Int32Array;
}

interface SystemWritePlan {
    readonly spec: UboSpec;
    readonly operations: Uint8Array;
    readonly indices: Int32Array;
    readonly alphaCutoff: ShaderUniformSlot | undefined;
}

const customPlans = new WeakMap<ShaderMaterial, CustomWritePlan>();
const systemPlans = new WeakMap<ShaderMaterial, SystemWritePlan>();

const SYSTEM_OPERATIONS: Record<string, number> = {
    world: 0,
    view: 1,
    projection: 2,
    viewProjection: 3,
    worldView: 4,
    worldViewProjection: 5,
    cameraPosition: 6,
    screenSize: 7,
    alphaCutoff: 8,
};

function getCustomWritePlan(material: ShaderMaterial, spec: UboSpec, data: ArrayBuffer): CustomWritePlan {
    const cached = customPlans.get(material);
    if (cached && cached.data === data && cached.size === material._uniformValues.size) {
        return cached;
    }
    const slots: ShaderUniformSlot[] = [];
    const indices: number[] = [];
    const kinds: number[] = [];
    const lengths: number[] = [];
    for (const [name, slot] of material._uniformValues) {
        if (_isShaderSystemUniform(name)) {
            continue;
        }
        const offset = spec._offsets.get(name);
        if (offset === undefined) {
            continue;
        }
        slot._v ??= 0;
        slots.push(slot);
        indices.push(offset / 4);
        kinds.push(slot.decl.type === "u32" ? 1 : slot.decl.type === "i32" ? 2 : 0);
        lengths.push(slot.value.length);
    }
    const plan: CustomWritePlan = {
        data,
        size: material._uniformValues.size,
        f32: new F32(data),
        u32: new U32(data),
        i32: new I32(data),
        slots,
        indices: new I32(indices),
        kinds: new U8(kinds),
        lengths: new I32(lengths),
        versions: new I32(slots.length).fill(-1),
    };
    customPlans.set(material, plan);
    return plan;
}

function getSystemWritePlan(material: ShaderMaterial, spec: UboSpec): SystemWritePlan {
    const cached = systemPlans.get(material);
    if (cached?.spec === spec) {
        return cached;
    }
    const operations: number[] = [];
    const indices: number[] = [];
    for (const uniform of material.uniformDecls) {
        if (!_isShaderSystemUniform(uniform.name)) {
            continue;
        }
        const offset = spec._offsets.get(uniform.name);
        if (offset !== undefined) {
            operations.push(SYSTEM_OPERATIONS[uniform.name]!);
            indices.push(offset / 4);
        }
    }
    const plan: SystemWritePlan = {
        spec,
        operations: new U8(operations),
        indices: new I32(indices),
        alphaCutoff: material._uniformValues.get("alphaCutoff"),
    };
    systemPlans.set(material, plan);
    return plan;
}

const writeCachedCustomUniforms: ShaderCustomUniformWriter = (engine, material, spec, data, ubo, bytes, uniformBatch) => {
    const plan = getCustomWritePlan(material, spec, data);
    let changed = false;
    for (let i = 0; i < plan.slots.length; i++) {
        const slot = plan.slots[i]!;
        const version = slot._v!;
        if (version === plan.versions[i]) {
            continue;
        }
        changed = true;
        plan.versions[i] = version;
        const index = plan.indices[i]!;
        const value = slot.value;
        const kind = plan.kinds[i]!;
        if (kind === 1) {
            plan.u32[index] = value[0]!;
        } else if (kind === 2) {
            plan.i32[index] = value[0]!;
        } else if (plan.lengths[i] === 1) {
            plan.f32[index] = value[0]!;
        } else {
            plan.f32.set(value, index);
        }
    }
    if (!changed) {
        return;
    }
    if (uniformBatch) {
        uniformBatch.queue(ubo, bytes);
    } else {
        engine._device.queue.writeBuffer(ubo, 0, bytes);
    }
};

const writeCachedSystemUniforms: ShaderSystemUniformWriter = (data, spec, material, mesh, camera, targetWidth, targetHeight) => {
    const plan = getSystemWritePlan(material, spec);
    const world = mesh.worldMatrix as unknown as Float32Array;
    const aspect = camera ? getEffectiveAspectRatio(camera, targetWidth, targetHeight) : 1;
    const view = camera ? (getViewMatrix(camera) as unknown as Float32Array) : null;
    const projection = camera ? (getProjectionMatrix(camera, aspect) as unknown as Float32Array) : null;
    const viewProjection = camera ? (getViewProjectionMatrix(camera, aspect) as unknown as Float32Array) : null;
    for (let i = 0; i < plan.operations.length; i++) {
        const index = plan.indices[i]!;
        switch (plan.operations[i]!) {
            case 0:
                data.set(world, index);
                break;
            case 1:
                view ? data.set(view, index) : data.fill(0, index, index + 16);
                break;
            case 2:
                projection ? data.set(projection, index) : data.fill(0, index, index + 16);
                break;
            case 3:
                viewProjection ? data.set(viewProjection, index) : data.fill(0, index, index + 16);
                break;
            case 4:
                view ? mat4MultiplyInto(data, index, view, 0, world, 0) : data.fill(0, index, index + 16);
                break;
            case 5:
                viewProjection ? mat4MultiplyInto(data, index, viewProjection, 0, world, 0) : data.fill(0, index, index + 16);
                break;
            case 6:
                if (camera) {
                    const cameraWorld = camera.worldMatrix as unknown as ArrayLike<number>;
                    data[index] = cameraWorld[12]!;
                    data[index + 1] = cameraWorld[13]!;
                    data[index + 2] = cameraWorld[14]!;
                } else {
                    data[index] = data[index + 1] = data[index + 2] = 0;
                }
                break;
            case 7:
                data[index] = targetWidth;
                data[index + 1] = targetHeight;
                break;
            case 8:
                data[index] = plan.alphaCutoff?.value[0] ?? 0.4;
                break;
        }
    }
};

/**
 * Enable cached serialization plans for ShaderMaterial system and custom uniform blocks.
 *
 * Call once before registering scenes that contain many ShaderMaterials or large custom uniform blocks.
 * The default path stays compact; enabled scenes avoid repeated layout lookups and rewrite only custom
 * uniform slots whose value changed.
 */
export function enableShaderMaterialUniformCaching(): void {
    _installShaderUniformWriters(writeCachedSystemUniforms, writeCachedCustomUniforms);
}
