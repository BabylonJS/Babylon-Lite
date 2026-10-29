import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface VectorState {
    x: number;
    y: number;
    z: number;
    w?: number;
    set: (...values: number[]) => void;
}

interface FixtureTexture {
    kind: "source" | "processed";
    url: string;
    options?: Record<string, unknown>;
}

interface FixtureEntity {
    name: string;
    kind: string;
    position: VectorState;
    rotationQuaternion: VectorState;
    scaling: VectorState;
    parent?: FixtureEntity;
    material?: Record<string, unknown>;
    options?: Record<string, unknown>;
    width?: number;
    height?: number;
    intensity?: number;
    diffuse?: number[];
    specular?: number[];
    emissionTexture?: FixtureTexture | null;
}

const fixture = vi.hoisted(() => ({
    canvas: { dataset: {} as Record<string, string> },
    engine: { drawCallCount: 4 },
    entities: [] as FixtureEntity[],
    sources: [] as FixtureTexture[],
    processed: [] as FixtureTexture[],
    camera: {} as Record<string, unknown>,
    lifecycle: [] as string[],
    releaseProcessing: [] as (() => void)[],
    releaseLtc: undefined as (() => void) | undefined,
    releaseFrame: undefined as (() => void) | undefined,
    processingError: undefined as Error | undefined,
}));

vi.mock("../../../packages/babylon-lite/src/index.js", () => {
    const vector = (x = 0, y = 0, z = 0, w?: number): VectorState => ({
        x,
        y,
        z,
        w,
        set(...values: number[]) {
            this.x = values[0]!;
            this.y = values[1]!;
            this.z = values[2]!;
            this.w = values[3];
        },
    });
    const node = (kind: string): FixtureEntity => ({
        name: "",
        kind,
        position: vector(),
        rotationQuaternion: vector(0, 0, 0, 1),
        scaling: vector(1, 1, 1),
    });
    return {
        createEngine: async () => fixture.engine,
        createSceneContext: () => ({}),
        createFreeCamera: (position: unknown, target: unknown) => {
            fixture.camera = { position, target };
            return fixture.camera;
        },
        createArcRotateCamera: (alpha: number, beta: number, radius: number, target: unknown) => {
            fixture.camera = { alpha, beta, radius, target };
            return fixture.camera;
        },
        attachFreeControl: () => {},
        attachControl: () => {},
        addToScene: (_scene: unknown, entity: FixtureEntity) => fixture.entities.push(entity),
        createBox: (_engine: unknown, options: Record<string, unknown>) => ({ ...node("box"), options }),
        createSphere: (_engine: unknown, options: Record<string, unknown>) => ({ ...node("sphere"), options }),
        createGround: (_engine: unknown, options: Record<string, unknown>) => ({ ...node("ground"), options }),
        createRectAreaLight: (position: [number, number, number], width: number, height: number, intensity = 1) => ({
            ...node("area"),
            position: vector(...position),
            width,
            height,
            intensity,
            emissionTexture: null,
        }),
        createPbrMaterial: (props: Record<string, unknown>) => ({ kind: "pbr", ...props }),
        createStandardMaterial: () => ({ kind: "standard", diffuseColor: [1, 1, 1], roughness: 0 }),
        setStandardEmissiveTexture: (material: Record<string, unknown>, texture: FixtureTexture) => {
            material.emissiveTexture = texture;
        },
        loadTexture2D: async (engine: unknown, url: string, options: Record<string, unknown>) => {
            expect(engine).toBe(fixture.engine);
            const source: FixtureTexture = { kind: "source", url, options };
            fixture.sources.push(source);
            return source;
        },
        processAreaLightTexture: async (engine: unknown, source: FixtureTexture) => {
            expect(engine).toBe(fixture.engine);
            expect(source.kind).toBe("source");
            fixture.lifecycle.push("process-start");
            await new Promise<void>((resolve) => fixture.releaseProcessing.push(resolve));
            if (fixture.processingError) {
                throw fixture.processingError;
            }
            const processed: FixtureTexture = { kind: "processed", url: source.url };
            fixture.processed.push(processed);
            fixture.lifecycle.push("process-ready");
            return processed;
        },
        enableRectAreaLights: async () => {
            expect(fixture.canvas.dataset.emissionReady).toBe("true");
            fixture.lifecycle.push("enable-start");
            await new Promise<void>((resolve) => {
                fixture.releaseLtc = resolve;
            });
            fixture.lifecycle.push("enable-ready");
        },
        registerScene: async () => {
            expect(fixture.canvas.dataset.ltcReady).toBe("true");
            expect(fixture.canvas.dataset.ready).toBeUndefined();
            fixture.lifecycle.push("register");
        },
        startEngine: async () => {
            fixture.lifecycle.push("first-frame-start");
            await new Promise<void>((resolve) => {
                fixture.releaseFrame = resolve;
            });
            fixture.lifecycle.push("first-frame-ready");
        },
    };
});

beforeEach(() => {
    vi.resetModules();
    fixture.canvas.dataset = {};
    fixture.entities = [];
    fixture.sources = [];
    fixture.processed = [];
    fixture.lifecycle = [];
    fixture.releaseProcessing = [];
    fixture.releaseLtc = undefined;
    fixture.releaseFrame = undefined;
    fixture.processingError = undefined;
    vi.stubGlobal("document", { getElementById: () => fixture.canvas });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function entity(name: string): FixtureEntity {
    const result = fixture.entities.find((entry) => entry.name === name);
    expect(result, `Missing fixture entity ${name}`).toBeDefined();
    return result!;
}

describe("Textured RectAreaLight lab fixtures", () => {
    it.each([319, 320])("scene %i awaits every processed map, LTC, and the first frame in order", async (id) => {
        await import(`../../../lab/lite/src/lite/scene${id}.ts`);
        const assets = id === 319 ? ["Cyberpunk_AI_Square.png"] : ["White.png", "Cyberpunk3_AI_Square.png", "Grey.png"];
        for (let index = 0; index < assets.length; index++) {
            await vi.waitFor(() => expect(fixture.releaseProcessing).toHaveLength(index + 1));
            expect(fixture.canvas.dataset.emissionReady).toBeUndefined();
            expect(fixture.canvas.dataset.ltcReady).toBeUndefined();
            expect(fixture.canvas.dataset.ready).toBeUndefined();
            expect(fixture.releaseLtc).toBeUndefined();
            fixture.releaseProcessing[index]!();
        }
        await vi.waitFor(() => expect(fixture.releaseLtc).toBeDefined());
        expect(fixture.canvas.dataset.emissionReady).toBe("true");
        expect(fixture.canvas.dataset.ltcReady).toBeUndefined();
        expect(fixture.canvas.dataset.ready).toBeUndefined();
        fixture.releaseLtc!();
        await vi.waitFor(() => expect(fixture.releaseFrame).toBeDefined());
        expect(fixture.canvas.dataset.ltcReady).toBe("true");
        expect(fixture.canvas.dataset.ready).toBeUndefined();
        fixture.releaseFrame!();
        await vi.waitFor(() => expect(fixture.canvas.dataset.ready).toBe("true"));
        expect(fixture.lifecycle).toEqual([
            ...assets.flatMap(() => ["process-start", "process-ready"]),
            "enable-start",
            "enable-ready",
            "register",
            "first-frame-start",
            "first-frame-ready",
        ]);
        expect(fixture.canvas.dataset.error).toBeUndefined();

        const lights = fixture.entities.filter((entry) => entry.kind === "area");
        expect(lights).toHaveLength(assets.length);
        const positions =
            id === 319
                ? [[2, 10, 0]]
                : [
                      [10, 10, 0],
                      [15, 10, -15],
                      [10, 10, -30],
                  ];
        lights.forEach((light, index) => {
            expect([light.width, light.height, light.intensity]).toEqual([6, 6, id === 319 ? 1 : 2]);
            expect(light.diffuse).toEqual([1, 1, 1]);
            expect(light.specular).toEqual([1, 1, 1]);
            expect(light.emissionTexture).toBe(fixture.processed[index]);
            expect(light.emissionTexture).not.toBe(fixture.sources[index]);
            expect(fixture.sources[index]).toEqual({
                kind: "source",
                url: `https://raw.githubusercontent.com/SergioRZMasson/TemporaryAssetsRepo/refs/heads/main/Textures/${assets[index]}`,
                options: { srgb: false },
            });
            const panel = light.parent!;
            expect(panel.options).toEqual({ width: 6, height: 6, depth: 0.01 });
            expect([panel.position.x, panel.position.y, panel.position.z]).toEqual(positions[index]);
            expect([panel.scaling.x, panel.scaling.y, panel.scaling.z]).toEqual([2, 2, 2]);
            const pitch = 5.976007358828584;
            const yaw = 1.5969762655748114;
            expect(panel.rotationQuaternion.x).toBeCloseTo(Math.cos(yaw / 2) * Math.sin(pitch / 2), 12);
            expect(panel.rotationQuaternion.y).toBeCloseTo(Math.sin(yaw / 2) * Math.cos(pitch / 2), 12);
            expect(panel.rotationQuaternion.z).toBeCloseTo(-Math.sin(yaw / 2) * Math.sin(pitch / 2), 12);
            expect(panel.rotationQuaternion.w).toBeCloseTo(Math.cos(yaw / 2) * Math.cos(pitch / 2), 12);
            expect(panel.material).toMatchObject({ disableLighting: true, emissiveColor: [1, 1, 1] });
            expect(panel.material!.diffuseTexture).toBe(fixture.sources[index]);
            expect(panel.material!.emissiveTexture).toBe(fixture.sources[index]);
        });
        expect(entity("ground").options).toEqual({ width: 120, height: 120 });
        if (id === 319) {
            expect(fixture.camera).toMatchObject({ position: { x: -20, y: 15, z: -15 }, target: { x: 0, y: 0, z: 0 }, nearPlane: 1, farPlane: 10000 });
            expect(entity("sphere").options).toEqual({ diameter: 2, segments: 32 });
            expect(entity("sphere").position.y).toBe(1);
            expect(entity("sphere2").options).toEqual({ diameter: 3, segments: 32 });
            expect([entity("sphere2").position.x, entity("sphere2").position.y, entity("sphere2").position.z]).toEqual([-3, 3, 0]);
            expect(entity("ground").material).toBe(entity("sphere").material);
            expect(entity("sphere").material).toMatchObject({ diffuseColor: [1, 1, 1], roughness: 0.2 });
            expect(entity("sphere2").material).toMatchObject({ diffuseColor: [1, 1, 1], roughness: 0.9 });
        } else {
            expect(fixture.camera).toMatchObject({ alpha: 3.78, beta: 1.15, radius: 93.92, target: { x: 15, y: 10, z: -15 }, nearPlane: 1, farPlane: 10000 });
            expect(entity("ground").material).toMatchObject({ baseColorFactor: [0.5, 0.5, 0.5, 1], roughnessFactor: 0.1, metallicFactor: 0 });
            expect(fixture.entities.filter((entry) => entry.kind === "sphere")).toHaveLength(0);
        }
    });

    it.each([319, 320])("scene %i surfaces preprocessing failure without declaring any readiness", async (id) => {
        const error = new Error("Image processing failed");
        fixture.processingError = error;
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        await import(`../../../lab/lite/src/lite/scene${id}.ts`);
        await vi.waitFor(() => expect(fixture.releaseProcessing).toHaveLength(1));
        fixture.releaseProcessing[0]!();
        await vi.waitFor(() => expect(fixture.canvas.dataset.error).toBe(String(error)));
        expect(log).toHaveBeenCalledWith(error);
        expect(fixture.canvas.dataset.ready).toBeUndefined();
        expect(fixture.canvas.dataset.emissionReady).toBeUndefined();
        expect(fixture.canvas.dataset.ltcReady).toBeUndefined();
        expect(fixture.releaseLtc).toBeUndefined();
    });

    it.each([
        [319, "standard", "#T7FXR8#103"],
        [320, "pbr", "#T7FXR8#102"],
    ])("scene %i uses public imports, complete wrappers, and immutable-golden parity", (id, suffix, snippet) => {
        const spec = readFileSync(resolve(`tests/lite/parity/scenes/scene${id}-textured-rect-area-lights-${suffix}.spec.ts`), "utf8");
        expect(spec).not.toMatch(/captureGolden|babylon-ref-scene|test\.skip|test\.fixme|RECAPTURE_GOLDEN/);
        expect(spec).toContain("existsSync(goldenRef)");
        expect(spec).toContain(`getSceneConfig(${id})`);
        expect(spec).toContain('toHaveAttribute("data-emission-ready", "true")');
        expect(spec).toContain('toHaveAttribute("data-ltc-ready", "true")');
        for (const engine of ["lite", "bjs"]) {
            const source = readFileSync(resolve(`lab/lite/src/${engine}/scene${id}.ts`), "utf8");
            expect(source).toContain(snippet);
            expect(source).not.toMatch(/\._gpu|GPUDevice|GPUTexture|GPUBuffer/);
            expect(source).toContain('canvas.dataset.emissionReady = "true"');
            expect(source).toContain('canvas.dataset.ltcReady = "true"');
            expect(source).toContain('canvas.dataset.ready = "true"');
            if (engine === "lite") {
                expect(source).not.toMatch(/from "babylon-lite\//);
            } else {
                expect(source).toContain("engine.displayLoadingUI = () => {};");
                expect(source).toContain("await processor.processAsync(source)");
                expect(source).not.toContain("panel.parent = light;");
                expect(source.indexOf('canvas.dataset.emissionReady = "true"')).toBeGreaterThan(source.indexOf("await processor.processAsync(source)"));
                expect(source.indexOf('canvas.dataset.ltcReady = "true"')).toBeGreaterThan(source.indexOf("await scene.whenReadyAsync()"));
                expect(source.indexOf('canvas.dataset.ready = "true"')).toBeGreaterThan(source.indexOf("await new Promise<void>"));
                if (id === 320) {
                    expect(source.indexOf('canvas.dataset.emissionReady = "true"')).toBeGreaterThan(source.indexOf('"light3", "Grey.png"'));
                }
            }
        }
        for (const [wrapper, entrypoint] of [
            ["scene", `/lite/src/lite/scene${id}.ts`],
            ["babylon-ref-scene", `/lite/src/bjs/scene${id}.ts`],
            ["bundle-scene", `/lite/bundle/scene${id}.js`],
        ]) {
            const html = readFileSync(resolve(`lab/lite/${wrapper}${id}.html`), "utf8");
            expect(html).toContain('<canvas id="renderCanvas"></canvas>');
            expect(html).toContain(`<script type="module" src="${entrypoint}"></script>`);
            if (wrapper !== "babylon-ref-scene") {
                expect(html).toContain('<script src="/loader.js"></script>');
            }
        }
        const config = JSON.parse(readFileSync(resolve("scene-config.json"), "utf8")) as { id: number; maxMad: number; maxRawKB: number }[];
        expect(config.filter((entry) => entry.id === id)).toEqual([expect.objectContaining({ maxMad: 0.05, maxRawKB: id === 319 ? 95 : 110 })]);
    });

    it("registers one runnable root-API Playground example with real emitted illumination", () => {
        const registry = readFileSync(resolve("playground/src/examples.ts"), "utf8");
        expect(registry).toContain('import TEXTURED_AREA_LIGHT from "../examples/textured-area-light.ts?raw";');
        expect(registry).toContain('{ id: "textured-area-light", label: "Lights — Textured area light", code: TEXTURED_AREA_LIGHT }');
        const example = readFileSync(resolve("playground/examples/textured-area-light.ts"), "utf8");
        expect(example).toContain('from "@babylonjs/lite"');
        expect(example).not.toMatch(/from "@babylonjs\/lite\/|GPUDevice|GPUTexture|\._/);
        expect(example).toContain("light.emissionTexture = await processAreaLightTexture(engine, source)");
        expect(example).toContain("addToScene(scene, light)");
        expect(example).toContain("await enableRectAreaLights(scene)");
        expect(example).toContain("await registerScene(scene)");
        expect(example).toContain("await startEngine(engine)");
        expect(example).toContain("ground.material = receiver");
        expect(example).toContain("sphere.material = receiver");
    });
});
