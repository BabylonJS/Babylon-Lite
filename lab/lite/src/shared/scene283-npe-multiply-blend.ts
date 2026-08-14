import { SCENE262_NPE_JSON } from "./scene262-npe.js";

interface MutableInput {
    name: string;
    value?: number | number[];
}

interface MutableBlock {
    customType: string;
    name: string;
    inputs: MutableInput[];
    capacity?: number;
    blendMode?: number;
    updateSpeed?: number;
    url?: string;
    value?: number | number[];
}

export const SCENE283_CLEAR_COLOR = [0.65, 0.45, 0.25, 1] as const;
export const SCENE283_CAMERA_RADIUS = 12;
export const SCENE283_STEPS = 40;
export const SCENE283_TEXTURE_SIZE = 32;

export interface Scene283NpeOptions {
    live?: boolean;
}

/** White radial sprite with a fully opaque core and zero-alpha outer texels. */
export function buildScene283TexturePixels(): Uint8Array {
    const pixels = new Uint8Array(SCENE283_TEXTURE_SIZE * SCENE283_TEXTURE_SIZE * 4);
    for (let y = 0; y < SCENE283_TEXTURE_SIZE; y++) {
        for (let x = 0; x < SCENE283_TEXTURE_SIZE; x++) {
            const dx = (x + 0.5) / SCENE283_TEXTURE_SIZE - 0.5;
            const dy = (y + 0.5) / SCENE283_TEXTURE_SIZE - 0.5;
            const alpha = Math.max(0, Math.min(1, (0.48 - Math.sqrt(dx * dx + dy * dy)) / 0.32));
            const offset = (y * SCENE283_TEXTURE_SIZE + x) * 4;
            pixels[offset] = 255;
            pixels[offset + 1] = 255;
            pixels[offset + 2] = 255;
            pixels[offset + 3] = Math.round(alpha * 255);
        }
    }
    return pixels;
}

function setBlockValue(blocks: MutableBlock[], name: string, value: number | number[]): void {
    blocks.find((block) => block.name === name)!.value = value;
}

/** Scene 283 - a compact serialized NPE fixture for Babylon.js Multiply blend mode. */
export function createScene283NpeJson(options: Scene283NpeOptions = {}): unknown {
    const live = options.live === true;
    const graph = structuredClone(SCENE262_NPE_JSON) as unknown as { blocks: MutableBlock[] };
    const system = graph.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
    system.capacity = 64;
    system.blendMode = 3;
    system.updateSpeed = 0.05;
    system.inputs.find((input) => input.name === "emitRate")!.value = 8;
    graph.blocks.find((block) => block.customType === "BABYLON.ParticleTextureSourceBlock")!.url = "";

    setBlockValue(graph.blocks, "Min Emit Power", live ? 1 : 0);
    setBlockValue(graph.blocks, "Max Emit Power", live ? 1 : 0);
    setBlockValue(graph.blocks, "Min Lifetime", 10);
    setBlockValue(graph.blocks, "Max Lifetime", 10);
    setBlockValue(graph.blocks, "Min size", 0.8);
    setBlockValue(graph.blocks, "Max size", 0.8);
    setBlockValue(graph.blocks, "Direction 1", live ? [0, 0.6, 0] : [0, 0, 0]);
    setBlockValue(graph.blocks, "Direction 2", live ? [0, 0.6, 0] : [0, 0, 0]);
    // Match the original screen-space field while reducing each sprite's projected size. This keeps
    // overlapping Multiply passes from amplifying cross-GPU blend rounding in the parity oracle.
    setBlockValue(graph.blocks, "Min Emit Box", [-3, -1.65, 0]);
    setBlockValue(graph.blocks, "Max Emit Box", [3, 1.65, 0]);
    setBlockValue(graph.blocks, "Min Scale", [1, 1]);
    setBlockValue(graph.blocks, "Max Scale", [1, 1]);
    setBlockValue(graph.blocks, "Color 1", [0.3, 0.8, 0.45, 1]);
    setBlockValue(graph.blocks, "Color 2", [0.3, 0.8, 0.45, 1]);
    setBlockValue(graph.blocks, "Dead Color", [0.3, 0.8, 0.45, 1]);
    return graph;
}
