import { F32, I32, U32 } from "../../engine/typed-arrays.js";
import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene-core.js";
import type { UboSpec } from "../../shader/fragment-types.js";
import type { ShaderMaterial } from "./shader-material.js";

interface RangeShaderMaterialState extends ShaderMaterial {
    _shaderCustomSpec?: UboSpec | null;
    _shaderCustomData?: ArrayBuffer | null;
    _shaderCustomUbo?: GPUBuffer | null;
    _shaderCustomVersion?: number;
    _rangeUniformUpdate?: (engine: EngineContext) => void;
    _rangeUniformScenes?: WeakMap<SceneContext, (deltaMs: number) => void>;
}

/** Opt one ShaderMaterial into direct packed-value landing and one ranged upload before each frame. */
export function enableShaderUniformRangeUpdates(scene: SceneContext, material: ShaderMaterial): void {
    const state = material as RangeShaderMaterialState;
    if (!state._rangeUniformUpdate) {
        installRangeUpdater(state);
    }
    const registrations = (state._rangeUniformScenes ??= new WeakMap());
    let callback = registrations.get(scene);
    if (!callback) {
        callback = () => state._rangeUniformUpdate!(scene.surface.engine);
        registrations.set(scene, callback);
    }
    if (!scene._beforeRender.includes(callback)) {
        // Public onBeforeRender() callbacks use unshift(), so this remains after their uniform mutations.
        scene._beforeRender.push(callback);
    }
}

function installRangeUpdater(material: RangeShaderMaterialState): void {
    const dirty = new Set<string>();
    let dirtyVersion = -1;
    const mark = (name: string) => {
        if (dirty.size === 0) {
            dirtyVersion = material._uniformVersion;
        }
        dirty.add(name);
    };
    for (const [name, slot] of material._uniformValues) {
        (slot as { value: Float32Array }).value = trackValue(slot.value, name, mark);
    }
    material._rangeUniformUpdate = (engine) => {
        if (dirty.size === 0) {
            return;
        }
        const spec = material._shaderCustomSpec;
        const data = material._shaderCustomData;
        const buffer = material._shaderCustomUbo;
        if (!spec || !data || !buffer) {
            return;
        }
        const directMutation = material._uniformVersion === dirtyVersion;
        if (!directMutation && material._shaderCustomVersion === material._uniformVersion) {
            dirty.clear();
            dirtyVersion = -1;
            return;
        }
        if (directMutation) {
            material._uniformVersion++;
            material._uboVersion = material._uniformVersion;
        }
        let min = 0x7fffffff;
        let max = -1;
        for (const name of dirty) {
            const slot = material._uniformValues.get(name)!;
            const offset = spec._offsets.get(name);
            if (offset === undefined) {
                continue;
            }
            writeTypedValue(data, offset, slot.decl.type, slot.value);
            min = Math.min(min, offset);
            max = Math.max(max, offset + slot.value.length * 4);
        }
        if (max > min) {
            engine._device.queue.writeBuffer(buffer, min, data, min, max - min);
        }
        dirty.clear();
        dirtyVersion = -1;
        material._shaderCustomVersion = material._uniformVersion;
    };
}

function trackValue(target: Float32Array, name: string, mark: (name: string) => void): Float32Array {
    const proxy = new Proxy(target, {
        get(array, key) {
            const value = Reflect.get(array, key, array) as unknown;
            if (typeof value !== "function") {
                return value;
            }
            const fn = value as (...args: unknown[]) => unknown;
            if (key === "subarray") {
                return (...args: unknown[]) => trackValue(fn.apply(array, args) as Float32Array, name, mark);
            }
            if (key === "set" || key === "fill" || key === "copyWithin" || key === "reverse" || key === "sort") {
                return (...args: unknown[]) => {
                    const result = fn.apply(array, args);
                    mark(name);
                    return result === array ? proxy : result;
                };
            }
            return fn.bind(array);
        },
        set(array, key, value) {
            const written = Reflect.set(array, key, value, array);
            if (typeof key === "string" && Number.isInteger(Number(key))) {
                mark(name);
            }
            return written;
        },
    });
    return proxy;
}

function writeTypedValue(data: ArrayBuffer, offset: number, type: string, value: Float32Array): void {
    if (type === "u32") {
        new U32(data, offset, 1)[0] = value[0]!;
    } else if (type === "i32") {
        new I32(data, offset, 1)[0] = value[0]!;
    } else {
        new F32(data, offset, value.length).set(value);
    }
}
