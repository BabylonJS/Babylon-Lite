import { F32 } from "../../engine/typed-arrays.js";
import type { EngineContext } from "../../engine/engine.js";
import type { Mesh } from "../mesh.js";
import { createUniformBuffer } from "../../resource/uniform-buffer.js";
import { _installMeshMaterialValidator, markMeshRenderableDirty } from "../../scene/mesh-scene-registry.js";
import { _registerStdExt } from "../../material/standard/standard-flags.js";
import { _registerPbrExt } from "../../material/pbr/pbr-flags.js";
import { _installMeshFeatureExtra } from "../../material/mesh-features.js";
import { _installPbrBindingContext } from "../../material/pbr/pbr-pipeline.js";
import { meshOpacityStandardExt } from "./mesh-opacity-standard.js";
import { meshOpacityPbrExt } from "./mesh-opacity-pbr.js";

type OpacityMesh = Mesh & { _opacity?: number };
interface OpacityBinding {
    readonly _buffer: GPUBuffer;
    readonly _device: GPUDevice;
    readonly _engine: EngineContext;
}

let _installed = false;
let _bindings: WeakMap<Mesh, Set<OpacityBinding>> | null = null;
const _value = new F32(1);

function assertMesh(mesh: Mesh, api: string): asserts mesh is OpacityMesh {
    if (!mesh || typeof mesh !== "object" || !("_gpu" in mesh)) {
        throw new Error(
            `${api}: "${(mesh as Mesh | undefined)?.name}" is not a Lite Mesh (for example a MeshLoD instance); per-mesh opacity is not supported on MeshLoD in this release.`
        );
    }
}

function validateMaterial(mesh: Mesh, material: Mesh["material"], opacity: number): void {
    if (opacity < 1 && material) {
        const family = material._buildGroup?._materialFamily;
        if (family !== "standard" && family !== "pbr") {
            throw new Error(`setMeshOpacity: mesh "${mesh.name}" uses a "${family}" material; mesh opacity supports only "standard" and "pbr" materials.`);
        }
    }
}

function ensureInstalled(): void {
    if (_installed) {
        return;
    }
    _registerStdExt(meshOpacityStandardExt);
    _registerPbrExt(meshOpacityPbrExt);
    _installMeshFeatureExtra((mesh) => (getMeshOpacity(mesh) < 1 ? 1 << 22 : 0));
    _installPbrBindingContext((context, _id, disposers) => {
        context._disposers = disposers;
    });
    _installMeshMaterialValidator((mesh, material) => validateMaterial(mesh, material, getMeshOpacity(mesh)));
    _installed = true;
}

/**
 * Set the opacity of one ordinary Standard/PBR mesh without modifying its material.
 *
 * Finite values are clamped to [0, 1]. Values below 1 select sorted blending with
 * depth writes disabled; zero omits colour and geometry draws. Shadows, picking
 * and mesh visibility are unchanged. Thin instances share their mesh's opacity.
 *
 * @throws RangeError - The value is not a finite number.
 * @throws Error - The target is not a Mesh, is disposed, or uses an unsupported material below 1.
 */
export function setMeshOpacity(mesh: Mesh, opacity: number): void {
    if (typeof opacity !== "number" || !Number.isFinite(opacity)) {
        throw new RangeError(`setMeshOpacity: opacity must be a finite number, got ${String(opacity)}`);
    }
    assertMesh(mesh, "setMeshOpacity");
    if (mesh._disposed) {
        throw new Error(`Mesh "${mesh.name}" cannot set opacity: it was disposed when it left its last scene. Create a new mesh instead.`);
    }
    const value = Math.min(1, Math.max(0, opacity));
    validateMaterial(mesh, mesh.material, value);
    ensureInstalled();
    const previous = mesh._opacity ?? 1;
    if (value === previous) {
        return;
    }
    mesh._opacity = value;
    mesh._skipColorDraw = value === 0;
    if ((previous === 1) !== (value === 1)) {
        markMeshRenderableDirty(mesh);
    }
    if (value === 1) {
        return;
    }
    const records = _bindings?.get(mesh);
    if (records) {
        _value[0] = value;
        for (const record of records) {
            if (record._engine._device === record._device) {
                record._device.queue.writeBuffer(record._buffer, 0, _value);
            }
        }
    }
}

/** Read the clamped opacity of a Mesh, or 1 when unset. Reading a disposed Mesh is allowed. */
export function getMeshOpacity(mesh: Mesh): number {
    assertMesh(mesh, "getMeshOpacity");
    return mesh._opacity ?? 1;
}

/** @internal Create one binding-owned uniform and retirement record; never a material-owned resource. */
export function _bindMeshOpacity(mesh: Mesh, engine: EngineContext, entries: GPUBindGroupEntry[], binding: number, disposers: (() => void)[] | undefined, route: string): number {
    if (!disposers) {
        throw new Error(`${route} mesh opacity binding requires binding-owned disposers.`);
    }
    _value[0] = getMeshOpacity(mesh);
    const buffer = createUniformBuffer(engine, _value);
    const record: OpacityBinding = { _buffer: buffer, _device: engine._device, _engine: engine };
    const map = (_bindings ??= new WeakMap());
    let records = map.get(mesh);
    if (!records) {
        map.set(mesh, (records = new Set()));
    }
    records.add(record);
    const liveRecords = records;
    disposers.push(() => {
        if (liveRecords.delete(record)) {
            buffer.destroy();
        }
    });
    entries.push({ binding, resource: { buffer } });
    return binding + 1;
}
