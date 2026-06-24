import type { LightBase } from "../light/types.js";

let _lightsByJson: WeakMap<object, (LightBase | undefined)[]> | null = null;

function map(): WeakMap<object, (LightBase | undefined)[]> {
    return (_lightsByJson ??= new WeakMap());
}

export function setGltfPunctualLight(json: object, lightIndex: number, light: LightBase): void {
    let lights = map().get(json);
    if (!lights) {
        lights = [];
        map().set(json, lights);
    }
    lights[lightIndex] = light;
}

export function getGltfPunctualLight(json: object | undefined, lightIndex: number): LightBase | undefined {
    return json ? _lightsByJson?.get(json)?.[lightIndex] : undefined;
}
