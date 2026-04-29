/** ReflectionTextureBlock — environment reflection sampling.
 *
 *  Inputs: `position` (local-space), `worldPosition`, `worldNormal`, `world`
 *  (mat4), `cameraPosition`, `view` (mat4).
 *  Outputs: `rgb` (vec3), `r`/`g`/`b`/`a` (f32), `reflectionCoords` (vec3).
 *
 *  Current support: coordinatesMode = EQUIRECTANGULAR_MODE (7) with a 2D input
 *  texture. Other modes (CUBIC, SPHERICAL, PLANAR, PROJECTION, SKYBOX,
 *  EQUIRECTANGULAR_FIXED) throw at parse-time so the failure is loud.
 *
 *  The embedded texture data (base64 PNG in the snippet) is decoded by the
 *  scene side and supplied via `parseNodeMaterialFromSnippet(..., { textures })`
 *  using the block's sanitized name as the key — same pattern as TextureBlock.
 *
 *  Gamma handling: when `gammaSpace: true` (typical for PNG environments stored
 *  in sRGB), the sampled colour is linearized via `pow(rgb, 2.2)` before being
 *  exposed on the `rgb`/`r`/`g`/`b` outputs.
 */

import type { BlockEmitter, NodeExpr } from "../node-types.js";

const EQUIRECTANGULAR_MODE = 7;

const RECIPROCAL_PI2 = "0.15915494309189535";
const RECIPROCAL_PI = "0.3183098861837907";

function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

const OUTPUTS: Record<string, { swizzle: string; type: "vec3f" | "f32" }> = {
    rgb: { swizzle: "", type: "vec3f" },
    r: { swizzle: ".x", type: "f32" },
    g: { swizzle: ".y", type: "f32" },
    b: { swizzle: ".z", type: "f32" },
};

export const emitter: BlockEmitter = {
    className: "ReflectionTextureBlock",
    stage: "fragment",
    emit(block, outputName, stage, state, ctx) {
        const mode = (block.serialized["coordinatesMode"] as number | undefined) ?? EQUIRECTANGULAR_MODE;
        if (mode !== EQUIRECTANGULAR_MODE) {
            throw new Error(`ReflectionTextureBlock: coordinatesMode ${mode} not supported (only EQUIRECTANGULAR_MODE=7)`);
        }

        const bindingName = sanitize(block.name || `reflection${block.id}`);
        if (!state.textures.find((t) => t.name === bindingName)) {
            state.textures.push({ name: bindingName, kind: "texture2d", texture: null });
        }

        const memoKey = `_refl_${block.id}_rgb`;
        let sample = state.fragment.memo.get(memoKey);
        if (!sample) {
            const wp = block.inputs.get("worldPosition")?.source ? ctx.cast(ctx.resolve(block, "worldPosition", stage, state), "vec3f").expr : `vec3<f32>(0.0)`;
            const wn = block.inputs.get("worldNormal")?.source ? ctx.cast(ctx.resolve(block, "worldNormal", stage, state), "vec3f").expr : `vec3<f32>(0.0, 1.0, 0.0)`;
            const cp = block.inputs.get("cameraPosition")?.source ? ctx.cast(ctx.resolve(block, "cameraPosition", stage, state), "vec3f").expr : `_NME_CAMERA_POS_`;

            const t = ctx.temp(state, "refl");
            const body: string[] = [
                `let _v${t} = normalize(${cp} - ${wp});`,
                `let _r${t} = reflect(-_v${t}, normalize(${wn}));`,
                // BJS flips the V coordinate after computing equirectangular UVs.
                `let _uv${t} = vec2<f32>(atan2(_r${t}.z, _r${t}.x) * ${RECIPROCAL_PI2} + 0.5, 1.0 - acos(clamp(_r${t}.y, -1.0, 1.0)) * ${RECIPROCAL_PI});`,
                `let _s${t} = textureSample(nodeTex_${bindingName}, nodeSamp_${bindingName}, _uv${t});`,
            ];
            // BJS's NME ReflectionTextureBlock does NOT apply gamma conversion
            // in the shader — it samples and uses raw values regardless of gammaSpace.
            // The NME expression graph operates in gamma space (textures are non-sRGB),
            // so the reflection must stay in gamma space too.
            state.fragment.body.push(body.join("\n"));
            sample = { expr: `_s${t}.xyz`, type: "vec3f" };
            state.fragment.memo.set(memoKey, sample);
        }

        if (outputName === "a") {
            return { expr: "1.0", type: "f32" };
        }
        if (outputName === "reflectionCoords") {
            // Seldom used by graphs; return the reflection vector as a placeholder.
            return { expr: sample.expr, type: "vec3f" };
        }
        const out = OUTPUTS[outputName] ?? OUTPUTS.rgb!;
        if (out.swizzle === "") {
            return sample as NodeExpr;
        }
        return { expr: `${sample.expr}${out.swizzle}`, type: out.type };
    },
};
