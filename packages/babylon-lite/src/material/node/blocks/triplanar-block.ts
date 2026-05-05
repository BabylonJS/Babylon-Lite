/** TriPlanarBlock — texture projection from position/normal.
 *
 * Implements the Babylon.js WGSL math for the common texture-source path:
 *   uvx = position.yz, uvy = position.zx, uvz = position.xy
 *   optional cube-facing flips
 *   sample X/Y/Z projections
 *   blend by pow(abs(normal), sharpness)
 *
 * Texture transform/level defaults are identity/1.0 unless serialized on the
 * block's embedded texture. Runtime ImageSource texture transforms are not part
 * of Lite's NME binding ABI today, so Scene 81 uses default transforms.
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

interface TextureTransform {
    readonly level: number;
    readonly uAng: number;
    readonly vAng: number;
    readonly wAng: number;
    readonly uOffset: number;
    readonly vOffset: number;
    readonly uScale: number;
    readonly vScale: number;
}

function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function formatFloat(value: number): string {
    if (Number.isInteger(value)) {
        return `${value}.0`;
    }
    return `${value}`;
}

function textureTransform(block: NodeBlock): TextureTransform {
    const tex = block.serialized["texture"] as Record<string, unknown> | null | undefined;
    const num = (name: string, fallback: number): number => {
        const value = tex?.[name];
        return typeof value === "number" ? value : fallback;
    };
    return {
        level: num("level", 1),
        uAng: num("uAng", 0),
        vAng: num("vAng", 0),
        wAng: num("wAng", 0),
        uOffset: num("uOffset", 0),
        vOffset: num("vOffset", 0),
        uScale: num("uScale", 1),
        vScale: num("vScale", 1),
    };
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

function emitTriPlanarSample(block: NodeBlock, stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): NodeExpr {
    if (stage !== "fragment") {
        throw new Error("TriPlanarBlock: texture projection is supported only in the fragment stage");
    }

    const stageState = state.fragment;
    const memoKey = `_triplanar_${block.id}_sample`;
    const memo = stageState.memo.get(memoKey);
    if (memo) {
        return memo;
    }

    const baseName = sanitize(block.name || `triPlanar${block.id}`);
    const texX = bindingName(block, "source", ctx, baseName);
    const texY = bindingName(block, "sourceY", ctx, texX);
    const texZ = bindingName(block, "sourceZ", ctx, texX);
    ensureBinding(state, texX);
    ensureBinding(state, texY);
    ensureBinding(state, texZ);

    const position = ctx.cast(ctx.resolve(block, "position", stage, state), "vec3f");
    const normal = ctx.cast(ctx.resolve(block, "normal", stage, state), "vec3f");
    const sharpnessInput = block.inputs.get("sharpness")?.source ? ctx.cast(ctx.resolve(block, "sharpness", stage, state), "f32").expr : "1.0";
    const transform = textureTransform(block);

    const temp = ctx.temp(state, "tri");
    const n = `_n${temp}`;
    const uvx = `_uvx${temp}`;
    const uvy = `_uvy${temp}`;
    const uvz = `_uvz${temp}`;
    const x = `_x${temp}`;
    const y = `_y${temp}`;
    const z = `_z${temp}`;
    const w = `_w${temp}`;
    const sample = `_sample${temp}`;

    stageState.body.push(`let ${n} = ${normal.expr};`);
    stageState.body.push(`var ${uvx} = (${position.expr}).yz;`);
    stageState.body.push(`var ${uvy} = (${position.expr}).zx;`);
    stageState.body.push(`var ${uvz} = (${position.expr}).xy;`);
    if (block.serialized["projectAsCube"] === true) {
        stageState.body.push(`${uvx} = (${uvx}).yx;`);
        stageState.body.push(`if (${n}.x >= 0.0) { ${uvx}.x = -${uvx}.x; }`);
        stageState.body.push(`if (${n}.y < 0.0) { ${uvy}.y = -${uvy}.y; }`);
        stageState.body.push(`if (${n}.z < 0.0) { ${uvz}.x = -${uvz}.x; }`);
    }
    stageState.body.push(`let _cU${temp} = cos(${formatFloat(transform.uAng)});`);
    stageState.body.push(`let _sU${temp} = sin(${formatFloat(transform.uAng)});`);
    stageState.body.push(`${uvx} = mat2x2<f32>(_cU${temp}, -_sU${temp}, _sU${temp}, _cU${temp}) * ${uvx};`);
    stageState.body.push(`let _cV${temp} = cos(${formatFloat(transform.vAng)});`);
    stageState.body.push(`let _sV${temp} = sin(${formatFloat(transform.vAng)});`);
    stageState.body.push(`${uvy} = mat2x2<f32>(_cV${temp}, _sV${temp}, -_sV${temp}, _cV${temp}) * ${uvy};`);
    stageState.body.push(`let _cW${temp} = cos(${formatFloat(transform.wAng)});`);
    stageState.body.push(`let _sW${temp} = sin(${formatFloat(transform.wAng)});`);
    stageState.body.push(`${uvz} = mat2x2<f32>(_cW${temp}, -_sW${temp}, _sW${temp}, _cW${temp}) * ${uvz};`);
    stageState.body.push(`let _scale${temp} = vec2<f32>(${formatFloat(transform.uScale)}, ${formatFloat(transform.vScale)});`);
    stageState.body.push(`let _offset${temp} = vec2<f32>(${formatFloat(transform.uOffset)}, ${formatFloat(transform.vOffset)});`);
    stageState.body.push(`${uvx} = ${uvx} * _scale${temp} + _offset${temp};`);
    stageState.body.push(`${uvy} = ${uvy} * _scale${temp} + _offset${temp};`);
    stageState.body.push(`${uvz} = ${uvz} * _scale${temp} + _offset${temp};`);
    stageState.body.push(`let ${x} = textureSample(nodeTex_${texX}, nodeSamp_${texX}, ${uvx});`);
    stageState.body.push(`let ${y} = textureSample(nodeTex_${texY}, nodeSamp_${texY}, ${uvy});`);
    stageState.body.push(`let ${z} = textureSample(nodeTex_${texZ}, nodeSamp_${texZ}, ${uvz});`);
    stageState.body.push(`let ${w} = pow(abs(${n}), vec3<f32>(${sharpnessInput}));`);
    stageState.body.push(
        `let ${sample} = ((${x} * ${w}.x + ${y} * ${w}.y + ${z} * ${w}.z) / (${w}.x + ${w}.y + ${w}.z)) * ${formatFloat(block.serialized["disableLevelMultiplication"] === true ? 1 : transform.level)};`
    );

    const result = { expr: sample, type: "vec4f" } as const;
    stageState.memo.set(memoKey, result);
    return result;
}

export const emitter: BlockEmitter = {
    className: "TriPlanarBlock",
    emit(block, outputName, stage, state, ctx) {
        if (outputName === "level") {
            const transform = textureTransform(block);
            return { expr: formatFloat(transform.level), type: "f32" };
        }
        const sample = emitTriPlanarSample(block, stage, state, ctx);
        const out = OUTPUT[outputName] ?? OUTPUT.rgba!;
        const serialized = block.serialized as { convertToLinearSpace?: boolean; convertToGammaSpace?: boolean };
        const converted = applyColorSpace(sample.expr, outputName, serialized.convertToLinearSpace === true, serialized.convertToGammaSpace === true);
        return { expr: converted === sample.expr ? `${sample.expr}${out.swizzle}` : converted, type: out.type };
    },
};
