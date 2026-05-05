/** BiPlanarBlock — two-axis variant of triplanar texture projection.
 *
 * Uses the Babylon.js/Iñigo Quilez biplanar method: choose major/median axes
 * from abs(normal), sample those projections with explicit position
 * derivatives, and blend with the shaped two-component weights.
 */

import type { BlockEmitter, NodeBlock, NodeBuildState, NodeEmitContext, NodeExpr, NodeValueType, Stage } from "../node-types.js";

const OUTPUT: Record<string, { swizzle: string; type: NodeValueType }> = {
    rgba: { swizzle: "", type: "vec4f" },
    rgb: { swizzle: ".xyz", type: "vec3f" },
    r: { swizzle: ".x", type: "f32" },
    g: { swizzle: ".y", type: "f32" },
    b: { swizzle: ".z", type: "f32" },
    a: { swizzle: ".w", type: "f32" },
};

function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function bindingName(block: NodeBlock, inputName: string, ctx: NodeEmitContext, fallback: string): string {
    const input = block.inputs.get(inputName);
    if (input?.source) {
        const producer = ctx.graph.blocks.get(input.source.blockId);
        return sanitize(producer?.name || fallback);
    }
    return sanitize(fallback);
}

function ensureBinding(state: NodeBuildState, name: string): void {
    if (!state.textures.find((t) => t.name === name)) {
        state.textures.push({ name, kind: "texture2d", texture: null });
    }
}

function applyColorSpace(expr: string, outputName: string, convertToLinear: boolean, convertToGamma: boolean): string {
    if (!convertToLinear && !convertToGamma) {
        return expr;
    }
    const power = convertToLinear ? "2.2" : "0.45454545";
    if (outputName === "rgba") {
        return `vec4<f32>(pow(max(${expr}.xyz, vec3<f32>(0.0)), vec3<f32>(${power})), ${expr}.w)`;
    }
    if (outputName === "rgb") {
        return `pow(max(${expr}.xyz, vec3<f32>(0.0)), vec3<f32>(${power}))`;
    }
    if (outputName === "r" || outputName === "g" || outputName === "b") {
        return `pow(max(${expr}${OUTPUT[outputName]!.swizzle}, 0.0), ${power})`;
    }
    return expr;
}

function emitBiPlanarSample(block: NodeBlock, stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): NodeExpr {
    if (stage !== "fragment") {
        throw new Error("BiPlanarBlock: texture projection is supported only in the fragment stage");
    }

    const stageState = state.fragment;
    const memoKey = `_biplanar_${block.id}_sample`;
    const memo = stageState.memo.get(memoKey);
    if (memo) {
        return memo;
    }

    const baseName = sanitize(block.name || `biPlanar${block.id}`);
    const texX = bindingName(block, "source", ctx, baseName);
    const texY = bindingName(block, "sourceY", ctx, texX);
    ensureBinding(state, texX);
    ensureBinding(state, texY);

    const position = ctx.cast(ctx.resolve(block, "position", stage, state), "vec3f");
    const normal = ctx.cast(ctx.resolve(block, "normal", stage, state), "vec3f");
    const sharpness = block.inputs.get("sharpness")?.source ? ctx.cast(ctx.resolve(block, "sharpness", stage, state), "f32").expr : "1.0";

    const temp = ctx.temp(state, "bi");
    const p = `_p${temp}`;
    const dx = `_dx${temp}`;
    const dy = `_dy${temp}`;
    const n = `_n${temp}`;
    const ma = `_ma${temp}`;
    const mi = `_mi${temp}`;
    const me = `_me${temp}`;
    const x = `_x${temp}`;
    const y = `_y${temp}`;
    const w = `_w${temp}`;
    const sample = `_sample${temp}`;

    stageState.body.push(`let ${p} = ${position.expr};`);
    stageState.body.push(`let ${dx} = dpdx(${p});`);
    stageState.body.push(`let ${dy} = dpdy(${p});`);
    stageState.body.push(`let ${n} = abs(${normal.expr});`);
    stageState.body.push(`var ${ma}: vec3<i32>;`);
    stageState.body.push(
        `if (${n}.x > ${n}.y && ${n}.x > ${n}.z) { ${ma} = vec3<i32>(0, 1, 2); } else if (${n}.y > ${n}.z) { ${ma} = vec3<i32>(1, 2, 0); } else { ${ma} = vec3<i32>(2, 0, 1); }`
    );
    stageState.body.push(`var ${mi}: vec3<i32>;`);
    stageState.body.push(
        `if (${n}.x < ${n}.y && ${n}.x < ${n}.z) { ${mi} = vec3<i32>(0, 1, 2); } else if (${n}.y < ${n}.z) { ${mi} = vec3<i32>(1, 2, 0); } else { ${mi} = vec3<i32>(2, 0, 1); }`
    );
    stageState.body.push(`let ${me} = vec3<i32>(3, 3, 3) - ${mi} - ${ma};`);
    stageState.body.push(
        `let ${x} = textureSampleGrad(nodeTex_${texX}, nodeSamp_${texX}, vec2<f32>(${p}[${ma}.y], ${p}[${ma}.z]), vec2<f32>(${dx}[${ma}.y], ${dx}[${ma}.z]), vec2<f32>(${dy}[${ma}.y], ${dy}[${ma}.z]));`
    );
    stageState.body.push(
        `let ${y} = textureSampleGrad(nodeTex_${texY}, nodeSamp_${texY}, vec2<f32>(${p}[${me}.y], ${p}[${me}.z]), vec2<f32>(${dx}[${me}.y], ${dx}[${me}.z]), vec2<f32>(${dy}[${me}.y], ${dy}[${me}.z]));`
    );
    stageState.body.push(`var ${w} = vec2<f32>(${n}[${ma}.x], ${n}[${me}.x]);`);
    stageState.body.push(`${w} = clamp((${w} - vec2<f32>(0.5773)) / vec2<f32>(1.0 - 0.5773), vec2<f32>(0.0), vec2<f32>(1.0));`);
    stageState.body.push(`${w} = pow(${w}, vec2<f32>(${sharpness} / 8.0));`);
    stageState.body.push(`let ${sample} = (${x} * ${w}.x + ${y} * ${w}.y) / (${w}.x + ${w}.y);`);

    const result = { expr: sample, type: "vec4f" } as const;
    stageState.memo.set(memoKey, result);
    return result;
}

export const emitter: BlockEmitter = {
    className: "BiPlanarBlock",
    emit(block, outputName, stage, state, ctx) {
        if (outputName === "level") {
            return { expr: "1.0", type: "f32" };
        }
        const sample = emitBiPlanarSample(block, stage, state, ctx);
        const out = OUTPUT[outputName] ?? OUTPUT.rgba!;
        const serialized = block.serialized as { convertToLinearSpace?: boolean; convertToGammaSpace?: boolean };
        const converted = applyColorSpace(sample.expr, outputName, serialized.convertToLinearSpace === true, serialized.convertToGammaSpace === true);
        return { expr: converted === sample.expr ? `${sample.expr}${out.swizzle}` : converted, type: out.type };
    },
};
