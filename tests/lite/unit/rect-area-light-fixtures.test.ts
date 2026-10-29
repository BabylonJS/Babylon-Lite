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
}

const fixture = vi.hoisted(() => ({
    canvas: { dataset: {} as Record<string, string> },
    entities: [] as FixtureEntity[],
    camera: {} as Record<string, unknown>,
    lifecycle: [] as string[],
    releaseLtc: undefined as (() => void) | undefined,
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
        createEngine: async () => ({ drawCallCount: 6 }),
        createSceneContext: () => ({}),
        createFreeCamera: (position: unknown, target: unknown) => {
            fixture.camera = { position, target };
            return fixture.camera;
        },
        attachFreeControl: () => {},
        addToScene: (_scene: unknown, entity: FixtureEntity) => fixture.entities.push(entity),
        createBox: (_engine: unknown, options: Record<string, unknown>) => ({ ...node("box"), options }),
        createSphere: (_engine: unknown, options: Record<string, unknown>) => ({ ...node("sphere"), options }),
        createGround: (_engine: unknown, options: Record<string, unknown>) => ({ ...node("ground"), options }),
        createTransformNode: (name: string, x = 0, y = 0, z = 0) => ({ ...node("transform"), name, position: vector(x, y, z) }),
        createRectAreaLight: (position: [number, number, number], width: number, height: number, intensity = 1) => ({
            ...node("area"),
            position: vector(...position),
            width,
            height,
            intensity,
        }),
        createPointLight: (position: [number, number, number], intensity: number) => ({ ...node("point"), position: vector(...position), intensity }),
        createHemisphericLight: (_direction: unknown, intensity: number) => ({ ...node("hemi"), intensity }),
        createPbrMaterial: (props: Record<string, unknown>) => ({ kind: "pbr", ...props }),
        createStandardMaterial: () => ({ kind: "standard", diffuseColor: [1, 1, 1], roughness: 0 }),
        enableRectAreaLights: async () => {
            fixture.lifecycle.push("enable-start");
            await new Promise<void>((resolve) => {
                fixture.releaseLtc = resolve;
            });
            fixture.lifecycle.push("enable-ready");
        },
        registerScene: async () => {
            expect(fixture.canvas.dataset.ltcReady).toBe("true");
            fixture.lifecycle.push("register");
        },
        startEngine: async () => {
            expect(fixture.canvas.dataset.ready).toBeUndefined();
            fixture.lifecycle.push("first-frame");
        },
    };
});

beforeEach(() => {
    vi.resetModules();
    fixture.canvas.dataset = {};
    fixture.entities = [];
    fixture.lifecycle = [];
    fixture.releaseLtc = undefined;
    vi.stubGlobal("document", { getElementById: () => fixture.canvas });
});

afterEach(() => vi.unstubAllGlobals());

function entity(name: string): FixtureEntity {
    const result = fixture.entities.find((entry) => entry.name === name);
    expect(result, `Missing fixture entity ${name}`).toBeDefined();
    return result!;
}

describe("RectAreaLight lab fixtures", () => {
    it.each([316, 317, 318])("scene %i awaits LTC upload and first frame before readiness", async (id) => {
        await import(`../../../lab/lite/src/lite/scene${id}.ts`);
        await vi.waitFor(() => expect(fixture.releaseLtc).toBeDefined());
        expect(fixture.lifecycle).toEqual(["enable-start"]);
        expect(fixture.canvas.dataset.ready).toBeUndefined();
        expect(fixture.canvas.dataset.ltcReady).toBeUndefined();
        fixture.releaseLtc!();
        await vi.waitFor(() => expect(fixture.canvas.dataset.ready).toBe("true"));
        expect(fixture.lifecycle).toEqual(["enable-start", "enable-ready", "register", "first-frame"]);
        expect(fixture.canvas.dataset.error).toBeUndefined();

        if (id === 316 || id === 317) {
            expect(fixture.camera.position).toEqual({ x: -20, y: 15, z: -15 });
            expect(fixture.camera.target).toEqual({ x: 0, y: 0, z: 0 });
            const lights = fixture.entities.filter((entry) => entry.kind === "area");
            expect(lights).toHaveLength(3);
            const colors = [
                [1, 1, 1],
                [1, 0, 0],
                [0, 1, 0],
            ];
            const positions = [
                [2, 3, -1],
                [-3, 3, 10],
                [-10, 3, -1],
            ];
            const rotations = [
                [5.976007358828584, 1.5969762655748114],
                [5.681046715241543, 0],
                [5.681046715241543, -1.5969762655748114],
            ];
            lights.forEach((light, index) => {
                expect([light.width, light.height, light.intensity]).toEqual([6, 6, 0.7]);
                expect(light.diffuse).toEqual(colors[index]);
                expect(light.specular).toEqual(colors[index]);
                const panel = light.parent!;
                expect(panel.options).toEqual({ width: 6, height: 6, depth: 0.01 });
                expect([panel.position.x, panel.position.y, panel.position.z]).toEqual(positions[index]);
                const [pitch, yaw] = rotations[index]!;
                const q = panel.rotationQuaternion;
                expect(q.x).toBeCloseTo(Math.cos(yaw! / 2) * Math.sin(pitch! / 2), 12);
                expect(q.y).toBeCloseTo(Math.sin(yaw! / 2) * Math.cos(pitch! / 2), 12);
                expect(q.z).toBeCloseTo(-Math.sin(yaw! / 2) * Math.sin(pitch! / 2), 12);
                expect(q.w).toBeCloseTo(Math.cos(yaw! / 2) * Math.cos(pitch! / 2), 12);
            });
            expect(entity("sphere").options).toEqual({ diameter: 2, segments: 32 });
            expect(entity("sphere").position.y).toBe(1);
            expect(entity("sphere2").options).toEqual({ diameter: 3, segments: 32 });
            expect([entity("sphere2").position.x, entity("sphere2").position.y, entity("sphere2").position.z]).toEqual([-3, 3, 0]);
            expect(entity("ground").options).toEqual({ width: 120, height: 120 });
            if (id === 316) {
                expect(entity("ground").material).toBe(entity("sphere").material);
                expect(entity("sphere").material).toMatchObject({ baseColorFactor: [1, 1, 1, 1], roughnessFactor: 0.1, metallicFactor: 0.1 });
                expect(entity("sphere2").material).toMatchObject({ baseColorFactor: [1, 0, 0, 1], roughnessFactor: 0.9, metallicFactor: 0.9 });
            } else {
                expect(entity("sphere").material).toMatchObject({ diffuseColor: [0, 0, 1], roughness: 0.1 });
                expect(entity("sphere2").material).toMatchObject({ diffuseColor: [1, 0, 0], roughness: 0.9 });
                expect(entity("ground").material).toMatchObject({ diffuseColor: [1, 1, 1], roughness: 0.2 });
            }
        } else {
            expect(fixture.entities.filter((entry) => ["area", "point", "hemi"].includes(entry.kind)).map((entry) => entry.kind)).toEqual(["area", "area", "point", "hemi"]);
            const front = entity("front-emitter");
            expect([front.width, front.height, front.intensity]).toEqual([2.5, 2, 3]);
            const parent = front.parent!;
            expect([parent.scaling.x, parent.scaling.y, parent.scaling.z]).toEqual([1.5, 0.75, 1.2]);
            expect(parent.rotationQuaternion.x).toBeCloseTo(Math.sin(-0.55 / 2), 12);
            expect(front.rotationQuaternion.y).toBeCloseTo(Math.sin(0.2 / 2), 12);
            expect(entity("front-panel").parent).toBe(front);
            const back = entity("back-facing-magenta");
            expect(back.diffuse).toEqual([1, 0, 1]);
            expect(back.rotationQuaternion).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
            expect(entity("ground").position.z - Number(entity("ground").options!.height) / 2).toBeGreaterThan(back.position.z);
            for (const metal of ["dielectric", "metal"]) {
                for (const tint of ["white", "tinted"]) {
                    const sphere = entity(`pbr-${metal}-${tint}`);
                    expect(sphere.position.z).toBeGreaterThan(back.position.z);
                    expect(sphere.material).toMatchObject({
                        baseColorFactor: tint === "white" ? [1, 1, 1, 1] : [0.8, 0.12, 0.04, 1],
                        metallicFactor: metal === "metal" ? 1 : 0,
                        roughnessFactor: 0.25,
                    });
                }
            }
        }
    });

    it.each([
        [316, "pbr"],
        [317, "standard"],
        [318, "transforms"],
    ])("scene %i parity never opens a reference or creates/skips a missing golden", (id, suffix) => {
        const spec = readFileSync(resolve("tests/lite/parity/scenes", `scene${id}-rect-area-lights-${suffix}.spec.ts`), "utf8");
        expect(spec).not.toMatch(/captureGolden|babylon-ref-scene|test\.skip|test\.fixme|RECAPTURE_GOLDEN/);
        expect(spec).toContain("existsSync(goldenRef)");
        expect(spec).toContain('toHaveAttribute("data-ltc-ready", "true")');
        for (const engine of ["lite", "bjs"]) {
            const source = readFileSync(resolve(`lab/lite/src/${engine}/scene${id}.ts`), "utf8");
            expect(source).not.toMatch(/\._gpu|GPUDevice|GPUTexture|GPUBuffer/);
            expect(source).toContain('canvas.dataset.ltcReady = "true"');
            expect(source).toContain('canvas.dataset.ready = "true"');
        }
    });

    it("keeps the BJS scene 318 panel in the same transformed frame as the emitter", () => {
        const reference = readFileSync(resolve("lab/lite/src/bjs/scene318.ts"), "utf8");
        expect(reference).toContain("light.parent = aim;");
        expect(reference).toContain("panel.parent = aim;");
        expect(reference).not.toContain("panel.parent = light;");
    });

    it.each([316, 317, 318])("scene %i has a production bundle entrypoint", (id) => {
        const html = readFileSync(resolve(`lab/lite/bundle-scene${id}.html`), "utf8");
        expect(html).toContain('<canvas id="renderCanvas"></canvas>');
        expect(html).toContain(`<script type="module" src="/lite/bundle/scene${id}.js"></script>`);
        expect(html).toContain('<script src="/loader.js"></script>');
    });
});
