import {
    applyEffectWrapper,
    createEffectWrapper,
    createGLEngine,
    createTexture3DFromPixels,
    drawEffect,
    isEffectReady,
    onContextRestored,
    resizeGLEngine,
    runRenderLoop,
    setEffectTexture3D,
    setViewport,
    stopRenderLoop,
} from "babylon-lite-gl";

const fragmentSource = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 glFragColor;
uniform sampler3D uVolume;
void main() {
    int column = min(4, int(floor(vUv.x * 5.0)));
    int row = min(1, int(floor(vUv.y * 2.0)));
    vec3 uvw = column == 4
        ? vec3(0.5)
        : (vec3(float(column % 2), float(row), float(column / 2)) + 0.5) * 0.5;
    glFragColor = texture(uVolume, uvw);
}`;

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const result = document.getElementById("result") as HTMLParagraphElement;
const engine = createGLEngine(canvas, { alpha: false });
const gl = engine.gl;
const pixels = new Uint8Array(2 * 2 * 2 * 4);
for (let z = 0; z < 2; z++) {
    for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
            const offset = ((z * 2 + y) * 2 + x) * 4;
            pixels.set([x ? 192 : 64, y ? 208 : 48, z ? 224 : 32, 255], offset);
        }
    }
}

const volume = createTexture3DFromPixels(engine, pixels, 2, 2, 2);
const wrapper = createEffectWrapper(engine, {
    name: "gl-texture-3d-source-test",
    fragmentSource,
    uniformNames: [],
    samplerNames: ["uVolume"],
});
const actual = new Uint8Array(4);
let verified = false;
let restorations = 0;

function checkPixel(column: number, row: number, expected: ArrayLike<number>): void {
    gl.readPixels(
        Math.floor(((column + 0.5) * canvas.width) / 5),
        Math.floor(((row + 0.5) * canvas.height) / 2),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        actual
    );
    for (let channel = 0; channel < 4; channel++) {
        if (Math.abs(actual[channel]! - expected[channel]!) > 2) {
            throw new Error(`3D texture sample (${column}, ${row}) channel ${channel}: expected ${expected[channel]}, got ${actual[channel]}`);
        }
    }
}

function checkVolume(): void {
    for (let row = 0; row < 2; row++) {
        for (let column = 0; column < 4; column++) {
            const offset = ((Math.floor(column / 2) * 2 + row) * 2 + (column % 2)) * 4;
            checkPixel(column, row, pixels.subarray(offset, offset + 4));
        }
        checkPixel(4, row, [128, 128, 128, 255]);
    }
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
        throw new Error(`3D texture source test: WebGL error ${error}`);
    }
}

onContextRestored(engine, () => {
    verified = false;
    restorations++;
    canvas.dataset.result = "pending";
    result.textContent = "Checking restored 3D texture…";
});

runRenderLoop(engine, () => {
    if (!isEffectReady(engine, wrapper.effect) || !volume.isReady) {
        return;
    }
    resizeGLEngine(engine);
    setViewport(engine);
    applyEffectWrapper(wrapper);
    setEffectTexture3D(engine, wrapper.effect, "uVolume", volume);
    drawEffect(engine);
    if (!verified) {
        try {
            checkVolume();
            verified = true;
            canvas.dataset.result = "passed";
            canvas.dataset.restorations = String(restorations);
            result.textContent = "PASS: eight texels and trilinear midpoint sampled correctly.";
        } catch (error) {
            canvas.dataset.result = "failed";
            result.textContent = `FAIL: ${String(error)}`;
            stopRenderLoop(engine);
            throw error;
        }
    }
});
