import "../unit/setup-webgpu-globals.js";
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import type { ComposedShader } from "../../../packages/babylon-lite/src/shader/fragment-types.js";
import { _PARALLAX_WGSL } from "../../../packages/babylon-lite/src/material/parallax/parallax-occlusion-wgsl.js";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types.js";
import type * as StandardGeometry from "../../../packages/babylon-lite/src/material/standard/standard-geometry-output-shader.js";
import type * as PbrGeometry from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-output-shader.js";
import type * as Fixtures from "../unit/parallax-occlusion-fixtures.js";

let server: Server;
let fixtureDirectory: string;
let fixtures: typeof Fixtures;
let standardGeometry: Pick<typeof StandardGeometry, "composeStandardGeometryShader">;
let pbrGeometry: Pick<typeof PbrGeometry, "composePbrGeometryShader">;
let origin: string;

test.beforeAll(async () => {
    fixtureDirectory = mkdtempSync(resolve(__dirname, ".parallax-oracle-"));
    const entry = resolve(fixtureDirectory, "fixtures.cjs");
    await build({
        stdin: {
            contents: `export * from "../unit/parallax-occlusion-fixtures.js";
export { composeStandardGeometryShader } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-output-shader.js";
export { composePbrGeometryShader } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-output-shader.js";`,
            resolveDir: __dirname,
            loader: "ts",
        },
        outfile: entry,
        bundle: true,
        platform: "node",
        format: "cjs",
        packages: "external",
        plugins: [
            {
                name: "parallax-raw-shaders",
                setup(builder) {
                    builder.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(dirname(args.importer), args.path.slice(0, -4)), namespace: "raw" }));
                    builder.onLoad({ filter: /.*/, namespace: "raw" }, (args) => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
                },
            },
        ],
    });
    const loaded = createRequire(resolve(__dirname, "parallax-occlusion.spec.ts"))(entry) as typeof Fixtures & typeof standardGeometry & typeof pbrGeometry;
    fixtures = loaded;
    standardGeometry = loaded;
    pbrGeometry = loaded;
    server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<!doctype html><title>Parallax numeric shader checks</title>");
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Parallax shader test server did not bind a TCP port.");
    }
    origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
    if (server?.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    if (fixtureDirectory) {
        rmSync(fixtureDirectory, { recursive: true, force: true });
    }
});

interface ShaderCase {
    name: string;
    vertex: string;
    fragment: string;
    buffers: GPUVertexBufferLayout[];
    targets: number;
}

function shaderCase(name: string, shader: ComposedShader, targets = 1): ShaderCase {
    return {
        name,
        vertex: fixtures.minifyParallaxTestWgsl(shader._vertexWGSL),
        fragment: fixtures.minifyParallaxTestWgsl(shader._fragmentWGSL),
        buffers: shader._vertexBufferLayouts,
        targets,
    };
}

test("parallax material variants compile into real WebGPU pipelines without screenshots", async ({ page }) => {
    const { makeParallaxPbrFixture, makeParallaxStandardFixture } = fixtures;
    const { composeStandardGeometryShader } = standardGeometry;
    const { composePbrGeometryShader } = pbrGeometry;
    const cases: ShaderCase[] = [];
    for (const normal of ["none", "cotangent", "tangent"] as const) {
        cases.push(shaderCase(`PBR ${normal}`, makeParallaxPbrFixture({ normal }).shader));
    }
    cases.push(shaderCase("PBR transformed UV2 surface layers", makeParallaxPbrFixture({ normal: "cotangent", optionalTextures: true, transforms: true, uv2: true }).shader));
    cases.push(shaderCase("PBR specular/glossiness UV2", makeParallaxPbrFixture({ normal: "cotangent", specGloss: true, transforms: true, uv2: true }).shader));
    for (const normal of ["none", "cotangent"] as const) {
        cases.push(shaderCase(`Standard ${normal}`, (await makeParallaxStandardFixture({ normal })).shader));
    }
    cases.push(
        shaderCase(
            "Standard transformed UV2 surface channels",
            (await makeParallaxStandardFixture({ normal: "cotangent", optionalTextures: true, transforms: true, uv2: true })).shader
        )
    );
    const standard = await makeParallaxStandardFixture({ normal: "cotangent", optionalTextures: true, transforms: true });
    cases.push(
        shaderCase(
            "Standard geometry reflectivity",
            composeStandardGeometryShader(standard.features, standard.meshFeatures, standard.fragments, [
                GeometryTextureType.REFLECTIVITY,
                GeometryTextureType.WORLD_NORMAL,
                GeometryTextureType.ALBEDO,
            ]),
            3
        )
    );
    const pbr = makeParallaxPbrFixture({ normal: "cotangent" });
    cases.push(
        shaderCase(
            "PBR geometry output",
            composePbrGeometryShader(
                pbr.compose,
                pbr.features,
                pbr.features2,
                pbr.meshFeatures,
                0,
                0,
                "",
                "",
                undefined,
                "",
                [GeometryTextureType.WORLD_NORMAL, GeometryTextureType.ALBEDO, GeometryTextureType.WORLD_POSITION],
                false
            ),
            3
        )
    );
    for (const caster of ["no-color", "esm"] as const) {
        cases.push(shaderCase(`PBR ${caster}`, makeParallaxPbrFixture({ caster }).shader, caster === "no-color" ? 0 : 1));
        cases.push(shaderCase(`Standard ${caster}`, (await makeParallaxStandardFixture({ caster })).shader, caster === "no-color" ? 0 : 1));
    }

    await page.goto(origin);
    const compiled = await page.evaluate(async (variants) => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("WebGPU adapter unavailable for parallax shader validation.");
        }
        const device = await adapter.requestDevice();
        const names: string[] = [];
        try {
            for (const variant of variants) {
                device.pushErrorScope("validation");
                const vertex = device.createShaderModule({ code: variant.vertex, label: `${variant.name} vertex` });
                const fragment = device.createShaderModule({ code: variant.fragment, label: `${variant.name} fragment` });
                for (const module of [vertex, fragment]) {
                    const info = await module.getCompilationInfo();
                    const errors = info.messages.filter((message) => message.type === "error");
                    if (errors.length) {
                        throw new Error(`${variant.name}: ${errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join("\n")}`);
                    }
                }
                await device.createRenderPipelineAsync({
                    label: variant.name,
                    layout: "auto",
                    vertex: { module: vertex, entryPoint: "main", buffers: variant.buffers },
                    fragment: { module: fragment, entryPoint: "main", targets: Array.from({ length: variant.targets }, () => ({ format: "rgba8unorm" as const })) },
                    primitive: { topology: "triangle-list" },
                    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
                });
                const error = await device.popErrorScope();
                if (error) {
                    throw new Error(`${variant.name}: ${error.message}`);
                }
                names.push(variant.name);
            }
            return names;
        } finally {
            device.destroy();
        }
    }, cases);
    expect(compiled).toEqual(cases.map((variant) => variant.name));
});

interface NumericCase {
    name: string;
    kind?: "constant" | "ramp-u" | "ramp-v" | "ridge";
    rgba?: readonly [number, number, number, number];
    channel?: number;
    center?: number;
    scale?: number;
    steps?: number;
    minSteps?: number;
    maxSteps?: number;
    refinement?: number;
    eye?: readonly [number, number, number];
    normal?: readonly [number, number, number];
    worldScale?: readonly [number, number];
    matrix?: readonly [number, number, number, number];
    translation?: readonly [number, number];
    degenerate?: boolean;
    contact?: "first" | "last";
    depthTolerance?: number;
    /** Constant-height texture size; ramps and ridges choose their own. */
    size?: readonly [number, number];
    /** Allocate a full mip chain so the solver's explicit level selection applies. */
    mips?: boolean;
    /** Surface area covered by one pixel, relative to one texel of a 64-texel texture. */
    pixelScale?: number;
    /** Exact height reads for cases whose march length is fully determined. */
    expectedSamples?: number;
}

const RIDGE_HEIGHTS = Array.from({ length: 64 }, (_, i) => Math.round(255 * (0.05 + 0.9 * Math.max(0, 1 - Math.abs((i + 0.5) / 64 - 0.3) / 0.14))));
const FLOOR: NumericCase["rgba"] = [0, 0, 0, 255];

// Zero heights march through every coarse step and every permitted bisection, so their read
// counts expose the texel cap, mip selection, angle budget and refinement budget exactly.
const NUMERIC_CASES: readonly NumericCase[] = [
    { name: "inset flat height", rgba: [64, 0, 0, 255] },
    { name: "centered flat height", rgba: [128, 0, 0, 255], center: 0.5 },
    { name: "raised flat height", rgba: [192, 0, 0, 255], center: 1 },
    { name: "green packed height", rgba: [0, 64, 0, 255], channel: 1 },
    { name: "blue packed height", rgba: [0, 0, 128, 255], channel: 2 },
    { name: "alpha packed height", rgba: [0, 0, 0, 192], channel: 3 },
    { name: "top hit exits immediately", rgba: [255, 0, 0, 255], center: 0.5, expectedSamples: 1 },
    { name: "sub-half-pixel rays read one height", rgba: [64, 0, 0, 255], scale: 0.0005, expectedSamples: 1 },
    { name: "bottom hit bisects without resampling the bracket", rgba: FLOOR, steps: 32, refinement: 8, expectedSamples: 5 },
    { name: "texel resolution caps coarse steps", rgba: FLOOR, size: [64, 64], eye: [0.8, 0, 1], steps: 16, expectedSamples: 6 },
    { name: "selected mip reduces texel steps", rgba: FLOOR, size: [64, 64], mips: true, pixelScale: 4, scale: 0.8, eye: [0.8, 0, 1], steps: 16, expectedSamples: 12 },
    { name: "single-level textures keep base texel steps", rgba: FLOOR, size: [64, 64], pixelScale: 4, scale: 0.8, eye: [0.8, 0, 1], steps: 16, expectedSamples: 17 },
    { name: "refinement budget caps bisections", rgba: FLOOR, scale: 0.8, eye: [0.8, 0, 1], steps: 16, refinement: 2, expectedSamples: 3 },
    { name: "adaptive near-front budget", rgba: FLOOR, size: [64, 64], scale: 0.8, eye: [0.2, 0, 1], minSteps: 4, maxSteps: 32, expectedSamples: 8 },
    { name: "adaptive oblique budget", rgba: FLOOR, size: [64, 64], scale: 0.8, minSteps: 4, maxSteps: 32, expectedSamples: 14 },
    { name: "adaptive grazing budget", rgba: FLOOR, size: [64, 64], scale: 0.8, eye: [4, 0, 1], minSteps: 4, maxSteps: 32, expectedSamples: 30 },
    { name: "single-step search", rgba: [64, 0, 0, 255], steps: 1, refinement: 1 },
    { name: "maximum configured subdivisions", rgba: [64, 0, 0, 255], steps: 64, refinement: 32 },
    { name: "normal incidence does not sample", eye: [0, 0, 1] },
    { name: "zero scale does not sample", scale: 0 },
    { name: "degenerate frame stays finite", degenerate: true },
    { name: "zero normal stays finite", normal: [0, 0, 0] },
    { name: "eye on the surface stays finite", eye: [0, 0, 0] },
    { name: "nearly tangent view stays finite", eye: [1, 0, 0.00001] },
    { name: "backface follows the oriented normal", rgba: [64, 0, 0, 255], eye: [0.8, 0.2, -1] },
    { name: "nonuniform world scale", rgba: [64, 0, 0, 255], worldScale: [2, 3] },
    { name: "linear height ramp", kind: "ramp-u" },
    { name: "reversed view direction", kind: "ramp-u", eye: [-0.8, 0.2, 1] },
    { name: "scaled height UVs", kind: "ramp-u", matrix: [0.7, 0, 0, 1], translation: [0.1, 0] },
    { name: "mirrored height UVs", kind: "ramp-u", matrix: [-1, 0, 0, 1], translation: [1, 0] },
    { name: "rotated height UVs", kind: "ramp-u", matrix: [0, 1, -1, 0], translation: [0, 1] },
    { name: "invertY height UVs", kind: "ramp-v", matrix: [1, 0, 0, -1], translation: [0, 1] },
    { name: "coarse-only ridge interpolation", kind: "ridge", scale: 0.8, eye: [0.8, 0, 1], steps: 6, refinement: 1, depthTolerance: 1 / 6 },
    { name: "refined first ridge contact", kind: "ridge", scale: 0.8, eye: [0.8, 0, 1], steps: 6, refinement: 8, depthTolerance: 1 / 48 },
    {
        name: "refinement cannot recover a ridge missed by coarse marching",
        kind: "ridge",
        scale: 0.8,
        eye: [0.8, 0, 1],
        steps: 4,
        refinement: 16,
        contact: "last",
        depthTolerance: 0.00001,
    },
];

function sampleRidge(u: number): number {
    const x = u * RIDGE_HEIGHTS.length - 0.5;
    const i = Math.floor(x);
    const weight = x - i;
    const left = RIDGE_HEIGHTS[Math.max(0, Math.min(RIDGE_HEIGHTS.length - 1, i))]!;
    const right = RIDGE_HEIGHTS[Math.max(0, Math.min(RIDGE_HEIGHTS.length - 1, i + 1))]!;
    return (left * (1 - weight) + right * weight) / 255;
}

function referenceRidgeDepth(base: number, ray: number, center: number, contact: NumericCase["contact"]): number {
    const error = (depth: number): number => depth + sampleRidge(base + ray * (center - depth)) - 1;
    const hits: number[] = [];
    let previous = error(0);
    // Search the entire ray independently of the shader's coarse/fine brackets.
    for (let i = 1; i <= 4096; i++) {
        let above = (i - 1) / 4096;
        let below = i / 4096;
        const current = error(below);
        if (previous < 0 && current >= 0) {
            for (let j = 0; j < 40; j++) {
                const mid = (above + below) / 2;
                if (error(mid) >= 0) {
                    below = mid;
                } else {
                    above = mid;
                }
            }
            hits.push((above + below) / 2);
        }
        previous = current;
    }
    expect(hits.length, "The ridge fixture must expose multiple ray intersections").toBeGreaterThan(1);
    return contact === "last" ? hits[hits.length - 1]! : hits[0]!;
}

function expectedCoarseSteps(input: NumericCase): number {
    const eye = input.eye ?? [0.8, 0.2, 1];
    const normal = input.normal ?? [0, 0, 1];
    const length = Math.hypot(...eye) * Math.hypot(...normal);
    const angle = length === 0 ? 0 : Math.min(1, Math.abs(eye[0] * normal[0] + eye[1] * normal[1] + eye[2] * normal[2]) / length);
    const min = input.minSteps ?? input.steps ?? 16;
    const max = input.maxSteps ?? input.steps ?? 16;
    return Math.ceil(min + (max - min) * (1 - angle));
}

function expectedUV(input: NumericCase): [number, number] {
    const uv: [number, number] = [0.5, 0.5];
    const eye = input.eye ?? [0.8, 0.2, 1];
    const scale = input.scale ?? 0.08;
    const normal = input.normal ?? [0, 0, 1];
    const eyeLength = Math.hypot(...eye);
    if (input.degenerate || scale === 0 || Math.hypot(...normal) === 0 || eyeLength === 0 || Math.abs(eye[2]) / eyeLength <= 0.0001) {
        return uv;
    }
    const worldScale = input.worldScale ?? [1, 1];
    const ray = [(eye[0] * scale) / (Math.abs(eye[2]) * worldScale[0]), (eye[1] * scale) / (Math.abs(eye[2]) * worldScale[1])];
    const center = input.center ?? 0;
    let hitDepth: number;
    if (input.kind === "ridge") {
        const matrix = input.matrix ?? [1, 0, 0, 1];
        const translation = input.translation ?? [0, 0];
        const base = matrix[0] * uv[0] + matrix[1] * uv[1] + translation[0];
        const delta = matrix[0] * ray[0]! + matrix[1] * ray[1]!;
        hitDepth = referenceRidgeDepth(base, delta, center, input.contact);
    } else if (input.kind === "ramp-u" || input.kind === "ramp-v") {
        const matrix = input.matrix ?? [1, 0, 0, 1];
        const translation = input.translation ?? [0, 0];
        const row = input.kind === "ramp-u" ? 0 : 2;
        const base = matrix[row]! * uv[0] + matrix[row + 1]! * uv[1] + translation[row / 2]!;
        const delta = matrix[row]! * ray[0]! + matrix[row + 1]! * ray[1]!;
        const slope = 256 / 255;
        hitDepth = (1 - slope * (base + delta * center)) / (1 - slope * delta);
    } else {
        hitDepth = 1 - (input.rgba ?? [128, 0, 0, 255])[input.channel ?? 0]! / 255;
    }
    return [uv[0] + ray[0]! * (center - hitDepth), uv[1] + ray[1]! * (center - hitDepth)];
}

test("the WGSL heightfield solver matches numeric references and its sample bound", async ({ page }) => {
    await page.goto(origin);
    const results = await page.evaluate(
        async ({ helper, inputs, ridgeHeights }) => {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                throw new Error("WebGPU adapter unavailable for the parallax numeric oracle.");
            }
            const device = await adapter.requestDevice();
            const values: Array<{ name: string; uv: number[]; samples: number }> = [];
            const vertex = device.createShaderModule({
                code: `@vertex fn main(@builtin(vertex_index) index:u32)->@builtin(position) vec4f{
let positions=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
return vec4f(positions[index],0.0,1.0);}`,
            });
            const counted = helper.replace(/(fn parallaxHeight\([^)]*\)->f32\{)/, "$1parallaxSampleCount+=1u;");
            if (counted === helper) {
                throw new Error("The numeric oracle failed to instrument the actual height lookup.");
            }
            try {
                for (const input of inputs) {
                    device.pushErrorScope("validation");
                    const rampU = input.kind === "ramp-u";
                    const rampV = input.kind === "ramp-v";
                    const ridge = input.kind === "ridge";
                    const [width, height] = input.size ?? [rampU || ridge ? 64 : 1, rampV ? 64 : 1];
                    const levels = input.mips ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
                    const texture = device.createTexture({
                        size: [width, height],
                        format: "rgba8unorm",
                        mipLevelCount: levels,
                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                    });
                    const output = device.createTexture({ size: [1, 1], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
                    const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                    try {
                        for (let level = 0; level < levels; level++) {
                            const levelWidth = Math.max(1, width >> level);
                            const levelHeight = Math.max(1, height >> level);
                            const pixels = new Uint8Array(levelWidth * levelHeight * 4);
                            for (let i = 0; i < levelWidth * levelHeight; i++) {
                                pixels.set(ridge ? [ridgeHeights[i]!, 0, 0, 255] : rampU || rampV ? [4 * i + 2, 0, 0, 255] : (input.rgba ?? [128, 0, 0, 255]), i * 4);
                            }
                            device.queue.writeTexture({ texture, mipLevel: level }, pixels, { bytesPerRow: levelWidth * 4 }, { width: levelWidth, height: levelHeight });
                        }
                        const pixel = 0.015625 * (input.pixelScale ?? 1);
                        const matrix = input.matrix ?? [1, 0, 0, 1];
                        const translation = input.translation ?? [0, 0];
                        const worldScale = input.worldScale ?? [1, 1];
                        const normal = input.normal ?? [0, 0, 1];
                        const eye = input.eye ?? [0.8, 0.2, 1];
                        const minSteps = input.minSteps ?? input.steps ?? 16;
                        const maxSteps = input.maxSteps ?? input.steps ?? 16;
                        const refinement = input.refinement ?? 8;
                        const fragment = device.createShaderModule({
                            code: `@group(0) @binding(0) var parallaxHeightTexture:texture_2d<f32>;
@group(0) @binding(1) var parallaxHeightSampler:sampler;
var<private> parallaxSampleCount:u32;
${counted}
@fragment fn main()->@location(0) vec4f{
let uv=vec2f(0.5);
let dx=vec2f(${pixel},0.0);
let dy=vec2f(0.0,${pixel});
let matrix=vec4f(${matrix.join(",")});
let heightUV=parallaxTransformUV(uv,matrix,vec2f(${translation.join(",")}));
let heightDx=vec2f(dot(matrix.xy,dx),dot(matrix.zw,dx));
let heightDy=vec2f(dot(matrix.xy,dy),dot(matrix.zw,dy));
let offset=parallaxOffset(vec3f(0.0),vec3f(${normal.join(",")}),vec3f(${input.degenerate ? 0 : worldScale[0] * pixel},0.0,0.0),vec3f(0.0,${worldScale[1] * pixel},0.0),vec3f(${eye.join(",")}),heightUV,heightDx,heightDy,vec4f(${input.scale ?? 0.08},${input.center ?? 0},0.0,0.0),vec4f(${minSteps},${maxSteps},${refinement},${input.channel ?? 0}));
return vec4f(uv+dx*offset.x+dy*offset.y,f32(parallaxSampleCount),1.0);
}`,
                        });
                        const info = await fragment.getCompilationInfo();
                        const errors = info.messages.filter((message) => message.type === "error");
                        if (errors.length) {
                            throw new Error(`${input.name}: ${errors.map((message) => message.message).join("\n")}`);
                        }
                        const pipeline = await device.createRenderPipelineAsync({
                            layout: "auto",
                            vertex: { module: vertex, entryPoint: "main" },
                            fragment: { module: fragment, entryPoint: "main", targets: [{ format: "rgba32float" }] },
                            primitive: { topology: "triangle-list" },
                        });
                        const bindings = device.createBindGroup({
                            layout: pipeline.getBindGroupLayout(0),
                            entries: [
                                { binding: 0, resource: texture.createView() },
                                { binding: 1, resource: device.createSampler({ minFilter: "linear", magFilter: "linear" }) },
                            ],
                        });
                        const commands = device.createCommandEncoder();
                        const pass = commands.beginRenderPass({ colorAttachments: [{ view: output.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
                        pass.setPipeline(pipeline);
                        pass.setBindGroup(0, bindings);
                        pass.draw(3);
                        pass.end();
                        commands.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 256 }, [1, 1]);
                        device.queue.submit([commands.finish()]);
                        await readback.mapAsync(GPUMapMode.READ);
                        const data = new Float32Array(readback.getMappedRange().slice(0, 16));
                        values.push({ name: input.name, uv: [data[0]!, data[1]!], samples: data[2]! });
                        readback.unmap();
                        const error = await device.popErrorScope();
                        if (error) {
                            throw new Error(`${input.name}: ${error.message}`);
                        }
                    } finally {
                        texture.destroy();
                        output.destroy();
                        readback.destroy();
                    }
                }
                return values;
            } finally {
                device.destroy();
            }
        },
        { helper: _PARALLAX_WGSL, inputs: NUMERIC_CASES, ridgeHeights: RIDGE_HEIGHTS }
    );

    expect(results).toHaveLength(NUMERIC_CASES.length);
    for (let i = 0; i < NUMERIC_CASES.length; i++) {
        const input = NUMERIC_CASES[i]!;
        const result = results[i]!;
        const expected = expectedUV(input);
        expect(result.uv.every(Number.isFinite), input.name).toBe(true);
        if (input.depthTolerance !== undefined) {
            const eye = input.eye ?? [0.8, 0.2, 1];
            const ray = (eye[0] * (input.scale ?? 0.08)) / (Math.abs(eye[2]) * (input.worldScale?.[0] ?? 1));
            expect(Math.abs((result.uv[0]! - expected[0]) / ray), input.name).toBeLessThanOrEqual(input.depthTolerance + 0.000001);
            expect(result.uv[1], input.name).toBeCloseTo(expected[1], 5);
        } else {
            expect(result.uv[0], input.name).toBeCloseTo(expected[0], 5);
            expect(result.uv[1], input.name).toBeCloseTo(expected[1], 5);
        }
        // At most one top read, the angle's coarse budget, and ceil(log2(refinement)) bisections.
        const sampleBound = 1 + expectedCoarseSteps(input) + Math.ceil(Math.log2(input.refinement ?? 8));
        expect(result.samples, input.name).toBeLessThanOrEqual(sampleBound);
        if (input.expectedSamples !== undefined) {
            expect(result.samples, input.name).toBe(input.expectedSamples);
        }
        if (input.name.includes("does not sample") || input.name.includes("stays finite")) {
            expect(result.samples, input.name).toBe(0);
        }
    }
    const coarseIndex = NUMERIC_CASES.findIndex((input) => input.name === "coarse-only ridge interpolation");
    const refinedIndex = NUMERIC_CASES.findIndex((input) => input.name === "refined first ridge contact");
    const coarseError = Math.abs(results[coarseIndex]!.uv[0]! - expectedUV(NUMERIC_CASES[coarseIndex]!)[0]);
    const refinedError = Math.abs(results[refinedIndex]!.uv[0]! - expectedUV(NUMERIC_CASES[refinedIndex]!)[0]);
    expect(coarseError, "The nonlinear fixture must distinguish refinement from coarse interpolation").toBeGreaterThan(0.01);
    expect(refinedError, "Contact refinement must improve the first-intersection estimate").toBeLessThan(coarseError / 8);
});
