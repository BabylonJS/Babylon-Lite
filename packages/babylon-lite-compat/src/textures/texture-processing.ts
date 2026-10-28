import {
    divideTextureProcessConstants,
    transmissionFractionConstants,
    transmissionScatterToSingleScatterAlbedoConstants,
    multiScatterToSingleScatterAlbedoConstants,
    singleScatterToMultiScatterAlbedoConstants,
    thinWalledScatterWeightConstants,
} from "babylon-lite";

import type { Scene } from "../scene/scene.js";
import { Color4 } from "../math/color.js";
import type { BaseTexture } from "./textures.js";
import { unsupported } from "../error.js";

const TEXTURE_PROCESSING_UNSUPPORTED =
    "Textured operands require Babylon.js's procedural texture processor/merger, render-target allocation, color-space conversion, UV-transform reconciliation, and intermediate-texture disposal lifecycle. Babylon Lite exposes no public general texture-processing contract to adapt.";

export enum TextureColorSpace {
    Linear = 0,
    SRGB = 1,
}

export enum ChannelMask {
    R = 0x1,
    G = 0x2,
    B = 0x4,
    A = 0x8,
    RGB = 0x7,
    RGBA = 0xf,
}

export enum TextureChannel {
    RGBA = 0,
    R = 1,
    G = 2,
    B = 3,
    A = 4,
}

export interface ITextureProcessOperand {
    texture: BaseTexture | null;
    factor?: Color4;
    channel?: TextureChannel;
    colorSpace?: TextureColorSpace;
    dispose?: () => void;
}

export interface ITextureProcessorOutputOptions {
    textureType?: number;
    samplingMode?: number;
    generateMipMaps?: boolean;
}

type ColorTuple = readonly [number, number, number, number];

function tuple(color: Color4): ColorTuple {
    return [color.r, color.g, color.b, color.a];
}

function color(values: ColorTuple): Color4 {
    return new Color4(values[0], values[1], values[2], values[3]);
}

function factor(operand: ITextureProcessOperand): Color4 {
    return operand.factor ?? new Color4(1, 1, 1, 1);
}

function applyMask(value: Color4, mask?: ChannelMask): Color4 {
    if (mask === undefined) {
        return value;
    }
    return new Color4(mask & ChannelMask.R ? value.r : 0, mask & ChannelMask.G ? value.g : 0, mask & ChannelMask.B ? value.b : 0, mask & ChannelMask.A ? value.a : 1);
}

function constantResult(value: Color4, mask?: ChannelMask): ITextureProcessOperand {
    return { texture: null, factor: applyMask(value, mask) };
}

function requireConstants(name: string, operands: readonly ITextureProcessOperand[]): void {
    if (operands.some((operand) => operand.texture)) {
        unsupported(name, TEXTURE_PROCESSING_UNSUPPORTED);
    }
}

export async function DivideTexturesAsync(
    _name: string,
    a: ITextureProcessOperand,
    b: ITextureProcessOperand,
    _scene: Scene,
    _outputColorSpace?: TextureColorSpace,
    outputChannelMask?: ChannelMask,
    _outputOptions?: ITextureProcessorOutputOptions
): Promise<ITextureProcessOperand> {
    requireConstants("DivideTexturesAsync", [a, b]);
    return constantResult(color(divideTextureProcessConstants(tuple(factor(a)), tuple(factor(b)))), outputChannelMask);
}

export async function TransmissionFractionAsync(
    _name: string,
    a: ITextureProcessOperand,
    b: ITextureProcessOperand,
    _scene: Scene,
    _outputColorSpace?: TextureColorSpace,
    outputChannelMask?: ChannelMask,
    _outputOptions?: ITextureProcessorOutputOptions
): Promise<ITextureProcessOperand> {
    requireConstants("TransmissionFractionAsync", [a, b]);
    return constantResult(color(transmissionFractionConstants(tuple(factor(a)), tuple(factor(b)))), outputChannelMask);
}

export async function TransmissionScatterToSingleScatterAlbedoAsync(
    _name: string,
    transmissionColor: ITextureProcessOperand,
    transmissionScatter: ITextureProcessOperand,
    _scene: Scene,
    _outputColorSpace?: TextureColorSpace,
    outputChannelMask?: ChannelMask,
    _outputOptions?: ITextureProcessorOutputOptions
): Promise<ITextureProcessOperand> {
    requireConstants("TransmissionScatterToSingleScatterAlbedoAsync", [transmissionColor, transmissionScatter]);
    return constantResult(
        color(transmissionScatterToSingleScatterAlbedoConstants(tuple(factor(transmissionColor)), tuple(factor(transmissionScatter)))),
        outputChannelMask
    );
}

export async function MultiScatterToSingleScatterAlbedoAsync(
    _name: string,
    input: ITextureProcessOperand,
    _scene: Scene,
    aniso = 0,
    scale?: ITextureProcessOperand
): Promise<ITextureProcessOperand> {
    requireConstants("MultiScatterToSingleScatterAlbedoAsync", scale ? [input, scale] : [input]);
    const inputFactor = factor(input);
    const scaled = scale
        ? new Color4(inputFactor.r * factor(scale).r, inputFactor.g * factor(scale).g, inputFactor.b * factor(scale).b, inputFactor.a * factor(scale).a)
        : inputFactor;
    return constantResult(color(multiScatterToSingleScatterAlbedoConstants(tuple(scaled), aniso)));
}

export async function SingleScatterToMultiScatterAlbedoAsync(
    _name: string,
    input: ITextureProcessOperand,
    _scene: Scene,
    aniso = 0,
    _outputOptions?: ITextureProcessorOutputOptions
): Promise<ITextureProcessOperand> {
    requireConstants("SingleScatterToMultiScatterAlbedoAsync", [input]);
    return constantResult(color(singleScatterToMultiScatterAlbedoConstants(tuple(factor(input)), aniso)));
}

export async function ThinWalledScatterWeightsAsync(
    _name: string,
    transmission: ITextureProcessOperand,
    scatter: ITextureProcessOperand,
    _scene: Scene
): Promise<{ transmission: ITextureProcessOperand; subsurface: ITextureProcessOperand }> {
    requireConstants("ThinWalledScatterWeightsAsync", [transmission, scatter]);
    const weights = thinWalledScatterWeightConstants(factor(transmission).r, factor(scatter).r);
    transmission.dispose?.();
    scatter.dispose?.();
    return {
        transmission: constantResult(new Color4(weights.transmission, weights.transmission, weights.transmission, weights.transmission)),
        subsurface: constantResult(new Color4(weights.subsurface, weights.subsurface, weights.subsurface, weights.subsurface)),
    };
}
