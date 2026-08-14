import { SCENE262_NPE_JSON } from "./scene262-npe.js";

export async function createNpeSprite2DFlareUrl(): Promise<string> {
    const size = 64;
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("NPE Sprite2D fixture requires an OffscreenCanvas 2D context");
    }
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.18, "rgba(255,221,138,0.95)");
    gradient.addColorStop(0.5, "rgba(255,95,54,0.55)");
    gradient.addColorStop(1, "rgba(16,3,24,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    return URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }));
}

export function createNpeSprite2DGraph(textureUrl: string): object {
    const source = structuredClone(SCENE262_NPE_JSON) as unknown as { blocks: Array<Record<string, unknown>> };
    const textureBlock = source.blocks.find((block) => block.customType === "BABYLON.ParticleTextureSourceBlock");
    const systemBlock = source.blocks.find((block) => block.customType === "BABYLON.SystemBlock");
    if (!textureBlock || !systemBlock) {
        throw new Error("NPE Sprite2D fixture graph is missing its texture or system block");
    }
    textureBlock.url = textureUrl;
    systemBlock.capacity = 600;
    systemBlock.blendMode = 0;
    systemBlock.updateSpeed = 0.0167;
    const inputs = systemBlock.inputs as Array<Record<string, unknown>>;
    const emitRate = inputs.find((input) => input.name === "emitRate");
    if (emitRate) {
        emitRate.value = 90;
    }
    return source;
}
