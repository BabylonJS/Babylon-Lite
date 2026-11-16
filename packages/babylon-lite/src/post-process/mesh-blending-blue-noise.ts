const MESH_BLENDING_BLUE_NOISE_SIZE = 128;

function hashPixel(x: number, y: number, seed: number): number {
    let value = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(y + seed, 0x119de1f3);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}

function fillChannel(data: Uint8Array, channel: number, seed: number): void {
    const pixelCount = MESH_BLENDING_BLUE_NOISE_SIZE * MESH_BLENDING_BLUE_NOISE_SIZE;
    const whiteNoise = new Float32Array(pixelCount);
    const highPassNoise = new Float32Array(pixelCount);
    const rankedIndices = new Array<number>(pixelCount);

    for (let y = 0; y < MESH_BLENDING_BLUE_NOISE_SIZE; y++) {
        for (let x = 0; x < MESH_BLENDING_BLUE_NOISE_SIZE; x++) {
            const index = y * MESH_BLENDING_BLUE_NOISE_SIZE + x;
            whiteNoise[index] = hashPixel(x, y, seed);
            rankedIndices[index] = index;
        }
    }

    for (let y = 0; y < MESH_BLENDING_BLUE_NOISE_SIZE; y++) {
        const previousY = (y - 1) & (MESH_BLENDING_BLUE_NOISE_SIZE - 1);
        const nextY = (y + 1) & (MESH_BLENDING_BLUE_NOISE_SIZE - 1);
        for (let x = 0; x < MESH_BLENDING_BLUE_NOISE_SIZE; x++) {
            const previousX = (x - 1) & (MESH_BLENDING_BLUE_NOISE_SIZE - 1);
            const nextX = (x + 1) & (MESH_BLENDING_BLUE_NOISE_SIZE - 1);
            const index = y * MESH_BLENDING_BLUE_NOISE_SIZE + x;
            const neighborAverage =
                (whiteNoise[y * MESH_BLENDING_BLUE_NOISE_SIZE + previousX]! +
                    whiteNoise[y * MESH_BLENDING_BLUE_NOISE_SIZE + nextX]! +
                    whiteNoise[previousY * MESH_BLENDING_BLUE_NOISE_SIZE + x]! +
                    whiteNoise[nextY * MESH_BLENDING_BLUE_NOISE_SIZE + x]! +
                    whiteNoise[previousY * MESH_BLENDING_BLUE_NOISE_SIZE + previousX]! +
                    whiteNoise[previousY * MESH_BLENDING_BLUE_NOISE_SIZE + nextX]! +
                    whiteNoise[nextY * MESH_BLENDING_BLUE_NOISE_SIZE + previousX]! +
                    whiteNoise[nextY * MESH_BLENDING_BLUE_NOISE_SIZE + nextX]!) *
                0.125;
            highPassNoise[index] = whiteNoise[index]! - neighborAverage;
        }
    }

    rankedIndices.sort((left, right) => highPassNoise[left]! - highPassNoise[right]! || left - right);
    for (let rank = 0; rank < pixelCount; rank++) {
        data[rankedIndices[rank]! * 2 + channel] = Math.floor((rank * 256) / pixelCount);
    }
}

/** Create the deterministic, spatially stable two-channel noise used by mesh blending. */
export function createMeshBlendingBlueNoiseData(): Uint8Array {
    const data = new Uint8Array(MESH_BLENDING_BLUE_NOISE_SIZE * MESH_BLENDING_BLUE_NOISE_SIZE * 2);
    fillChannel(data, 0, 0x68bc21eb);
    fillChannel(data, 1, 0x2f6e2b1d);
    return data;
}
