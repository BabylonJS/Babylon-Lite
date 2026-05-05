import type { BlockEmitter, NodeBlock, NodeBuildState, NodeEmitContext, NodeExpr, Stage } from "../node-types.js";

function tryResolve(block: NodeBlock, inputName: string, stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): NodeExpr | null {
    const input = block.inputs.get(inputName);
    if (!input?.source) {
        return null;
    }
    return ctx.resolve(block, inputName, stage, state);
}

function ensureRgb2HslHelper(state: NodeBuildState, stage: Stage): void {
    state[stage].helpers.set(
        "nme_rgb2hsl",
        `fn nme_rgb2hsl(color: vec3<f32>) -> vec3<f32> {
    let r = color.x;
    let g = color.y;
    let b = color.z;
    let maxc = max(r, max(g, b));
    let minc = min(r, min(g, b));
    var h = 0.0;
    var s = 0.0;
    let l = (maxc + minc) / 2.0;
    if (maxc != minc) {
        let d = maxc - minc;
        if (l > 0.5) {
            s = d / (2.0 - maxc - minc);
        } else {
            s = d / (maxc + minc);
        }
        if (maxc == r) {
            var add = 0.0;
            if (g < b) {
                add = 6.0;
            }
            h = (g - b) / d + add;
        } else if (maxc == g) {
            h = (b - r) / d + 2.0;
        } else if (maxc == b) {
            h = (r - g) / d + 4.0;
        }
        h = h / 6.0;
    }
    return vec3<f32>(h, s, l);
}`
    );
}

function ensureHsl2RgbHelper(state: NodeBuildState, stage: Stage): void {
    state[stage].helpers.set(
        "nme_hue2rgb",
        `fn nme_hue2rgb(p: f32, q: f32, tt: f32) -> f32 {
    var t = tt;
    if (t < 0.0) {
        t = t + 1.0;
    }
    if (t > 1.0) {
        t = t - 1.0;
    }
    if (t < 1.0 / 6.0) {
        return p + (q - p) * 6.0 * t;
    }
    if (t < 1.0 / 2.0) {
        return q;
    }
    if (t < 2.0 / 3.0) {
        return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    }
    return p;
}`
    );
    state[stage].helpers.set(
        "nme_hsl2rgb",
        `fn nme_hsl2rgb(hsl: vec3<f32>) -> vec3<f32> {
    let h = hsl.x;
    let s = hsl.y;
    let l = hsl.z;
    var r: f32;
    var g: f32;
    var b: f32;
    if (s == 0.0) {
        r = l;
        g = l;
        b = l;
    } else {
        var q: f32;
        if (l < 0.5) {
            q = l * (1.0 + s);
        } else {
            q = l + s - l * s;
        }
        let p = 2.0 * l - q;
        r = nme_hue2rgb(p, q, h + 1.0 / 3.0);
        g = nme_hue2rgb(p, q, h);
        b = nme_hue2rgb(p, q, h - 1.0 / 3.0);
    }
    return vec3<f32>(r, g, b);
}`
    );
}

export const emitter: BlockEmitter = {
    className: "ColorConverterBlock",
    emit(block, outputName, stage, state, ctx) {
        const rgb = tryResolve(block, "rgb", stage, state, ctx);
        if (rgb) {
            const rgbExpr = ctx.cast(rgb, "vec3f").expr;
            if (outputName === "hsl") {
                ensureRgb2HslHelper(state, stage);
                return { expr: `nme_rgb2hsl(${rgbExpr})`, type: "vec3f" };
            }
            return { expr: rgbExpr, type: "vec3f" };
        }

        const hsl = tryResolve(block, "hsl", stage, state, ctx);
        if (hsl) {
            const hslExpr = ctx.cast(hsl, "vec3f").expr;
            if (outputName === "rgb") {
                ensureHsl2RgbHelper(state, stage);
                return { expr: `nme_hsl2rgb(${hslExpr})`, type: "vec3f" };
            }
            return { expr: hslExpr, type: "vec3f" };
        }

        return { expr: "vec3<f32>(0.0, 0.0, 0.0)", type: "vec3f" };
    },
};
