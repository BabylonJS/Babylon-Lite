import type { BlockEmitter } from "../node-types.js";
import { formatFloat } from "./_math-factory.js";

interface ColorStep {
    readonly step: number;
    readonly color: { readonly r: number; readonly g: number; readonly b: number };
}

function readSteps(raw: unknown): ColorStep[] {
    if (!Array.isArray(raw)) {
        return [
            { step: 0, color: { r: 0, g: 0, b: 0 } },
            { step: 1, color: { r: 1, g: 1, b: 1 } },
        ];
    }
    return raw
        .map((entry): ColorStep | null => {
            if (!entry || typeof entry !== "object") {
                return null;
            }
            const e = entry as Record<string, unknown>;
            const c = e.color as Record<string, unknown> | undefined;
            if (typeof e.step !== "number" || !c || typeof c.r !== "number" || typeof c.g !== "number" || typeof c.b !== "number") {
                return null;
            }
            return { step: e.step, color: { r: c.r, g: c.g, b: c.b } };
        })
        .filter((entry): entry is ColorStep => entry !== null);
}

function colorLiteral(step: ColorStep): string {
    return `vec3<f32>(${formatFloat(step.color.r)}, ${formatFloat(step.color.g)}, ${formatFloat(step.color.b)})`;
}

export const emitter: BlockEmitter = {
    className: "GradientBlock",
    emit(block, _outputName, stage, state, ctx) {
        const input = block.inputs.get("gradient");
        const steps = readSteps(block.serialized.colorSteps);
        if (!input?.source || steps.length === 0) {
            return { expr: "vec3<f32>(0.0, 0.0, 0.0)", type: "vec3f" };
        }
        const gradient = ctx.resolve(block, "gradient", stage, state);
        const g = gradient.type === "f32" ? gradient.expr : `((${gradient.expr}).x)`;
        const tempColor = ctx.temp(state, "gradientColor");
        const tempPosition = ctx.temp(state, "gradientPosition");
        state[stage].body.push(`var ${tempColor}: vec3<f32> = ${colorLiteral(steps[0]!)};`);
        state[stage].body.push(`var ${tempPosition}: f32;`);
        for (let i = 1; i < steps.length; i++) {
            const previous = steps[i - 1]!;
            const current = steps[i]!;
            state[stage].body.push(`${tempPosition} = clamp((${g} - ${formatFloat(previous.step)}) / (${formatFloat(current.step)} - ${formatFloat(previous.step)}), 0.0, 1.0);`);
            state[stage].body.push(`${tempColor} = mix(${tempColor}, ${colorLiteral(current)}, ${tempPosition});`);
        }
        return { expr: tempColor, type: "vec3f" };
    },
};
