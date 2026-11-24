import type { NpeBlockEvaluator } from "../npe-build.js";
import { createComponentScratch, mapComponents } from "./particle-component-map.js";

const OPERATIONS: ReadonlyArray<(value: number) => number> = [
    Math.cos,
    Math.sin,
    Math.abs,
    Math.exp,
    (value) => Math.pow(2, value),
    Math.round,
    Math.floor,
    Math.ceil,
    Math.sqrt,
    Math.log,
    Math.tan,
    Math.atan,
    Math.acos,
    Math.asin,
    Math.sign,
    (value) => -value,
    (value) => 1 - value,
    (value) => 1 / value,
    (value) => (value * 180) / Math.PI,
    (value) => (value * Math.PI) / 180,
    (value) => (value >= 0 ? value - Math.floor(value) : value - Math.ceil(value)),
];

/**
 * `ParticleTrigonometryBlock` — apply one of Babylon.js's 21 unary operations (indexed like
 * `ParticleTrigonometryBlockOperations`, default Cos) to every component of `input`. Unknown operations and an
 * unconnected `input` publish no output; the output keeps the `input` typing without truncating.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const operation = OPERATIONS[typeof block.serialized.operation === "number" ? block.serialized.operation : 0];
        if (!operation || !ctx.isConnected(block, "input")) {
            return;
        }
        const input = ctx.input(block, "input");
        const scratch = createComponentScratch();
        ctx.setOutput(block.id, "output", (i) => mapComponents(input(i), operation, scratch), ctx.isInt(block, "input"));
    },
};
