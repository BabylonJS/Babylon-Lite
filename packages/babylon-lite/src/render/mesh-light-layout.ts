import { MAX_LIGHTS } from "../light/types.js";
import type { UboField } from "../shader/fragment-types.js";
import { wgsl } from "../shader/wgsl.js";

/** @internal */
export function appendMeshLightUboFields(fields: UboField[]): void {
    fields.push({ _name: "lc", _type: "u32" });
    fields.push({ _name: "li", _type: `array<vec4<u32>, ${Math.ceil(MAX_LIGHTS / 4)}>` });
}

/** @internal */
export function meshLightIndexWGSL(meshVar: string, functionName = "mli"): string {
    return wgsl`fn ${functionName}(i: u32) -> u32 { return ${meshVar}.li[i / 4u][i % 4u]; }`;
}
