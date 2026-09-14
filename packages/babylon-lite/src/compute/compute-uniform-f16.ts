import { DV } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import { _getAdapterOptions } from "../engine/engine.js";
import type { ComputeUniformArena } from "./compute-uniform-arena.js";
import type { ComputeUniformLayout, ComputeUniformWriter } from "./compute-uniform-writer.js";
import { _createComputeUniformWriter, _installComputeUniformF16Write } from "./compute-uniform-writer.js";

function roundToEven(value: number, divisor: number): number {
    const quotient = Math.floor(value / divisor);
    const remainder = value - quotient * divisor;
    const halfway = divisor / 2;
    return remainder > halfway || (remainder === halfway && (quotient & 1) !== 0) ? quotient + 1 : quotient;
}

function floatToFloat16(writer: ComputeUniformWriter, byteOffset: number, value: number): void {
    const scratch = writer._f16Scratch!;
    scratch.setFloat64(0, value, false);
    const high = scratch.getUint32(0, false);
    const low = scratch.getUint32(4, false);
    const sign = (high >>> 16) & 0x8000;
    const exponent = (high >>> 20) & 0x7ff;
    const mantissa = (high & 0xfffff) * 0x100000000 + low;
    let bits: number;
    if (exponent === 0x7ff) {
        bits = sign | (mantissa === 0 ? 0x7c00 : 0x7e00);
    } else if (exponent === 0) {
        bits = sign;
    } else {
        const unbiasedExponent = exponent - 1023;
        if (unbiasedExponent > 15) {
            bits = sign | 0x7c00;
        } else if (unbiasedExponent < -25) {
            bits = sign;
        } else {
            const significand = 0x10000000000000 + mantissa;
            if (unbiasedExponent < -14) {
                bits = sign | roundToEven(significand, 2 ** (28 - unbiasedExponent));
            } else {
                let halfExponent = unbiasedExponent + 15;
                let halfSignificand = roundToEven(significand, 0x40000000000);
                if (halfSignificand === 0x800) {
                    halfSignificand = 0x400;
                    halfExponent++;
                }
                bits = halfExponent >= 31 ? sign | 0x7c00 : sign | (halfExponent << 10) | (halfSignificand - 0x400);
            }
        }
    }
    writer._dataView.setUint16(byteOffset, bits, true);
}

/** Query adapter capability before engine creation, or enabled support on an existing engine. */
export function isComputeF16Supported(engine: EngineContext): boolean;
export function isComputeF16Supported(): Promise<boolean>;
export function isComputeF16Supported(engine?: EngineContext): boolean | Promise<boolean> {
    if (engine) {
        return engine._device.features.has("shader-f16");
    }
    return navigator.gpu
        .requestAdapter({
            powerPreference: "high-performance",
            ..._getAdapterOptions(),
        })
        .then((adapter) => adapter?.features.has("shader-f16") === true);
}

/** Create a typed arena writer whose layout may contain f16 scalar, vector, or matrix fields. */
export function createComputeUniformF16Writer(arena: ComputeUniformArena, slot: number, layout: ComputeUniformLayout): ComputeUniformWriter {
    if (!arena._task.engine._device.features.has("shader-f16")) {
        throw new Error('createComputeUniformF16Writer requires createEngine(..., { requiredFeatures: ["shader-f16"] }).');
    }
    _installComputeUniformF16Write(floatToFloat16);
    return _createComputeUniformWriter(arena, slot, layout, new DV(new ArrayBuffer(8)));
}
