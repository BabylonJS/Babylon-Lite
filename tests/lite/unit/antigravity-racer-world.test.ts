/**
 * World tests for the Antigravity Racer: the playground's lighting/terrain/shadow constants, and
 * the persistent-world contract the demo's lifetime and its split-screen mode depend on.
 *
 * Like `antigravity-racer-track.test.ts`, the demo modules here resolve to the REAL `babylon-lite`
 * package source (`lab/node_modules/babylon-lite` is a workspace symlink), so the scenes, meshes,
 * shader materials, storage buffers and the CSM generator under test are the real ones — only the
 * GPU device is a stub, and only the two asset-loading demo modules (remote height map, glTF
 * boulders) are mocked. That is what makes these assertions meaningful: they exercise the same
 * wiring the demo runs.
 */

import { describe, expect, it, vi } from "vitest";

import { createMeshFromData } from "../../../packages/babylon-lite/src/mesh/mesh-factories";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { getCsmReceiverTexture } from "../../../packages/babylon-lite/src/shadow/csm-directional-shadow-generator";
import { _getShadowTaskCasterMeshes } from "../../../packages/babylon-lite/src/frame-graph/shadow-inputs";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

const constantsPath = "../../../lab/lite/src/demos/antigravity-racer/constants.js";
const terrainPath = "../../../lab/lite/src/demos/antigravity-racer/terrain.js";
const worldPath = "../../../lab/lite/src/demos/antigravity-racer/world.js";
const environmentPath = "../../../lab/lite/src/demos/antigravity-racer/environment.js";

/** Counting GPU device stand-in: enough for meshes, storage buffers and the CSM depth array. */
const gpu = vi.hoisted(() => {
    const textures: { width: number; height: number; layers: number; format: string }[] = [];
    let buffers = 0;
    let writes = 0;
    const device = {
        createBuffer(desc: { size: number }) {
            buffers++;
            const storage = new ArrayBuffer(desc.size);
            return { size: desc.size, getMappedRange: () => storage, unmap: () => {}, destroy: () => {} };
        },
        createTexture(desc: { size: { width: number; height: number; depthOrArrayLayers?: number }; format: string }) {
            textures.push({ width: desc.size.width, height: desc.size.height, layers: desc.size.depthOrArrayLayers ?? 1, format: desc.format });
            return { width: desc.size.width, height: desc.size.height, createView: () => ({}), destroy: () => {} };
        },
        createSampler: () => ({}),
        queue: {
            writeBuffer(): void {
                writes++;
            },
        },
    };
    const engine = { _device: device } as unknown as EngineContext;
    // `EngineContext extends SurfaceContext`, and `createSceneContext(surface)` reads `surface.engine`.
    (engine as unknown as { engine: unknown }).engine = engine;
    return {
        engine,
        textures,
        counts: {
            get buffers(): number {
                return buffers;
            },
            get writes(): number {
                return writes;
            },
        },
    };
});

// The height map is fetched from playground.babylonjs.com and the boulders come from a glTF, so
// those two builders are replaced. Everything else in `world.ts` — lights, cascades, track pieces,
// residency, caster wiring — runs for real. Both mocks count their calls, which is exactly what
// proves the world is built once per session rather than once per mode. `rocks.js` is replaced
// wholesale rather than partially: importing the original would pull in `assets.js`, whose glTF
// decoder bases resolve through lab-only Vite aliases; its one-line `addRocksToScene` is restated
// below so the residency + mode-scene wiring still runs for real.
const fakes = vi.hoisted(() => ({ createTerrain: vi.fn(), createRocks: vi.fn() }));

vi.mock("../../../lab/lite/src/demos/antigravity-racer/terrain.js", async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return { ...original, createTerrain: fakes.createTerrain };
});
vi.mock("../../../lab/lite/src/demos/antigravity-racer/rocks.js", async () => {
    const { addToScene } = await import("../../../packages/babylon-lite/src/scene/scene-core");
    return {
        createRocks: fakes.createRocks,
        addRocksToScene: (scene: SceneContext, rocks: { root: unknown }): void => addToScene(scene, rocks.root as Parameters<typeof addToScene>[1]),
    };
});

const constants = (await import(constantsPath)) as Record<string, number> & {
    HEMI_LIGHT_DIRECTION: [number, number, number];
    SUN_DIRECTION: [number, number, number];
    SUN_POSITION: [number, number, number];
    SPACE_CLEAR_COLOR: { r: number; g: number; b: number; a: number };
};
const { HEIGHTMAP_URL, GROUND_TEXTURE_URL } = (await import(terrainPath)) as { HEIGHTMAP_URL: string; GROUND_TEXTURE_URL: string };
const { RACER_ENVIRONMENT_URL } = (await import(environmentPath)) as { RACER_ENVIRONMENT_URL: string };

interface ShaderMaterialLike {
    _shadowCasterMaterial?: unknown;
    samplerDecls: { name: string }[];
    _textureSlots: Map<string, { current: unknown }>;
    _storageBufferSlots: Map<string, { current: unknown }>;
}
interface RenderWorldLike {
    lights: { shadowGenerator?: unknown }[];
    sun: { shadowGenerator?: unknown };
    shadowGenerator: Parameters<typeof getCsmReceiverTexture>[0];
    track: { mesh: Mesh; material: { material: ShaderMaterialLike; casterMaterial: ShaderMaterialLike; frameData: Float32Array } };
    rocks: { pool: { meshes: Mesh[] } };
    terrain: Mesh;
    baseCasters: readonly Mesh[];
}
interface RacerWorldsLike {
    track: { controlPoints: { x: number; y: number; z: number }[]; rebuild(): void };
    primary: RenderWorldLike;
    secondary(): RenderWorldLike;
    worlds: readonly RenderWorldLike[];
}
interface WorldModule {
    createRacerWorlds: (engine: unknown, assets: unknown) => Promise<RacerWorldsLike>;
    addWorldToScene: (scene: SceneContext, world: RenderWorldLike) => void;
    setWorldCasters: (world: RenderWorldLike, extra: readonly Mesh[]) => void;
}
const { createRacerWorlds, addWorldToScene, setWorldCasters } = (await import(worldPath)) as WorldModule;

const trackTextures = { straight: { id: "S" }, curve: { id: "C" }, emissive: { id: "E" }, boost: { id: "B" } };

/** A stand-in mesh with real GPU-side bookkeeping — the two mocked modules hand these back. */
function stubMesh(name: string): Mesh {
    const mesh = createMeshFromData(gpu.engine, name, new Float32Array([0, 0, 0]), new Float32Array([0, 1, 0]), new Uint32Array([0, 0, 0]));
    mesh.receiveShadows = true;
    return mesh;
}

async function buildWorlds(): Promise<RacerWorldsLike> {
    fakes.createTerrain.mockReset();
    fakes.createRocks.mockReset();
    fakes.createTerrain.mockImplementation(() => Promise.resolve(stubMesh("antigrav-terrain")));
    fakes.createRocks.mockImplementation(() => {
        const meshes = [stubMesh("rock-0"), stubMesh("rock-1")];
        return { root: { children: meshes }, pool: { meshes } };
    });
    return createRacerWorlds(gpu.engine, { trackTextures });
}

/** One mode scene. `defaultRenderTask: false` keeps the stub device out of swapchain territory. */
function modeScene(): SceneContext {
    return createSceneContext(gpu.engine, { defaultRenderTask: false });
}

function cascadeTextureCount(): number {
    return gpu.textures.filter((t) => t.format === "depth32float" && t.layers === constants.SHADOW_CASCADES).length;
}

describe("lighting and sky", () => {
    it("matches the playground's two lights exactly", () => {
        expect(constants.HEMI_LIGHT_DIRECTION).toEqual([1, 1, 0]);
        expect(constants.HEMI_LIGHT_INTENSITY).toBe(0.5);
        expect(constants.SUN_DIRECTION).toEqual([-1, -2, -1]);
        expect(constants.SUN_POSITION).toEqual([120, 50, 100]);
        expect(constants.SUN_INTENSITY).toBe(1);
    });

    it("keeps black as the fallback clear color", () => {
        expect(constants.SPACE_CLEAR_COLOR).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    });

    it("uses the HDR environment requested from Playground CGA05F#831", () => {
        expect(RACER_ENVIRONMENT_URL).toBe("https://playground.babylonjs.com/textures/environment.env");
    });
});

describe("terrain", () => {
    it("loads the playground's own height map and ground sheet at runtime", () => {
        expect(HEIGHTMAP_URL).toBe("https://playground.babylonjs.com/textures/heightMap.png");
        expect(GROUND_TEXTURE_URL).toBe("https://playground.babylonjs.com/textures/ground.jpg");
    });

    it("keeps CreateGroundFromHeightMap's exact parameters", () => {
        expect(constants.TERRAIN_SIZE).toBe(400);
        expect(constants.TERRAIN_SUBDIVISIONS).toBe(600);
        expect(constants.TERRAIN_MIN_HEIGHT).toBe(0);
        expect(constants.TERRAIN_MAX_HEIGHT).toBe(25);
        expect(constants.TERRAIN_Y).toBe(-2.05);
        expect(constants.TERRAIN_UV_SCALE).toBe(6);
    });
});

describe("cascaded shadows", () => {
    it("matches the playground's CascadedShadowGenerator settings", () => {
        expect(constants.SHADOW_MAP_SIZE).toBe(1024);
        expect(constants.SHADOW_CASCADES).toBe(4);
        expect(constants.SHADOW_LAMBDA).toBe(1);
        expect(constants.SHADOW_BIAS).toBe(0.001);
        expect(constants.SHADOW_MAX_Z).toBe(1500);
    });

    it("allocates one 1024x1024x4 depth array per world, never per mode", async () => {
        const before = cascadeTextureCount();
        const worlds = await buildWorlds();
        expect(cascadeTextureCount() - before).toBe(1);
        expect(gpu.textures.at(-1)).toMatchObject({
            width: constants.SHADOW_MAP_SIZE,
            height: constants.SHADOW_MAP_SIZE,
            layers: constants.SHADOW_CASCADES,
            format: "depth32float",
        });

        // Five mode switches: each builds a fresh scene and re-adds the world.
        for (let i = 0; i < 5; i++) {
            addWorldToScene(modeScene(), worlds.primary);
        }
        expect(cascadeTextureCount() - before).toBe(1);

        // The split-screen pane adds exactly one more, and only the first time.
        worlds.secondary();
        worlds.secondary();
        expect(cascadeTextureCount() - before).toBe(2);
    });
});

describe("persistent world resources", () => {
    it("builds the terrain and the boulders once per session, never per mode", async () => {
        const worlds = await buildWorlds();
        expect(fakes.createTerrain).toHaveBeenCalledTimes(1);
        expect(fakes.createRocks).toHaveBeenCalledTimes(1);

        for (let i = 0; i < 4; i++) {
            addWorldToScene(modeScene(), worlds.primary);
        }
        const second = worlds.secondary();
        addWorldToScene(modeScene(), second);

        expect(fakes.createTerrain).toHaveBeenCalledTimes(1);
        expect(fakes.createRocks).toHaveBeenCalledTimes(1);
        // Both panes draw the very same ground and boulders — only the receiver binding differs,
        // and Lite rebuilds that per scene.
        expect(second.terrain).toBe(worlds.primary.terrain);
        expect(second.rocks).toBe(worlds.primary.rocks);
    });

    it("re-adds the same meshes and lights to every mode scene", async () => {
        const worlds = await buildWorlds();
        const world = worlds.primary;

        const sceneA = modeScene();
        addWorldToScene(sceneA, world);
        const sceneB = modeScene();
        addWorldToScene(sceneB, world);

        for (const scene of [sceneA, sceneB]) {
            expect(scene.meshes).toContain(world.track.mesh);
            expect(scene.meshes).toContain(world.terrain);
            expect(scene.meshes).toEqual(expect.arrayContaining(world.rocks.pool.meshes));
            expect(scene.lights).toEqual([...world.lights]);
        }
        // Same mesh instances in both: a mode switch re-registers the world, it never rebuilds it.
        expect(sceneA.meshes).toEqual(sceneB.meshes);
    });

    it("keeps the deformed track a shadow receiver whose caster twin shares its frame buffer", async () => {
        const worlds = await buildWorlds();
        const { mesh, material } = worlds.primary.track;

        expect(mesh.receiveShadows).toBe(true);
        expect(material.material._shadowCasterMaterial).toBe(material.casterMaterial);
        expect(material.casterMaterial.samplerDecls).toEqual([]);
        // One buffer, two materials: the visible road and its shadow can never disagree.
        expect(material.casterMaterial._storageBufferSlots.get("trackFrames")!.current).toBe(material.material._storageBufferSlots.get("trackFrames")!.current);
    });

    it("re-uploads a control-point edit into every world in place, allocating nothing", async () => {
        const worlds = await buildWorlds();
        const second = worlds.secondary();
        const buffersBefore = gpu.counts.buffers;
        const writesBefore = gpu.counts.writes;
        const primaryFrameX = worlds.primary.track.material.frameData[12];
        const secondFrameX = second.track.material.frameData[12];

        worlds.track.controlPoints[0]!.x += 25;
        worlds.track.rebuild();

        // Both panes moved, in the same tick, from the one shared spline source.
        expect(worlds.primary.track.material.frameData[12]).not.toBe(primaryFrameX);
        expect(second.track.material.frameData[12]).not.toBe(secondFrameX);
        expect(second.track.material.frameData).toEqual(worlds.primary.track.material.frameData);
        // No churn while dragging: two uploads per world (frames + info), no new GPU buffers.
        expect(gpu.counts.buffers).toBe(buffersBefore);
        expect(gpu.counts.writes).toBe(writesBefore + 4);
    });
});

describe("split-screen world isolation", () => {
    it("gives each pane its own light, cascades and track receiver", async () => {
        const worlds = await buildWorlds();
        const primary = worlds.primary;
        const second = worlds.secondary();

        // Memoized: a second split-screen race reuses the pane-2 world.
        expect(worlds.secondary()).toBe(second);
        expect(worlds.worlds).toHaveLength(2);

        expect(second.sun).not.toBe(primary.sun);
        expect(second.shadowGenerator).not.toBe(primary.shadowGenerator);
        expect(primary.sun.shadowGenerator).toBe(primary.shadowGenerator);
        expect(second.sun.shadowGenerator).toBe(second.shadowGenerator);

        // A cascade array is fit to ONE camera, so the receiver material must not be shared either.
        expect(second.track.mesh).not.toBe(primary.track.mesh);
        expect(second.track.material.material).not.toBe(primary.track.material.material);
        expect(primary.track.material.material._textureSlots.get("csmShadow")!.current).toBe(getCsmReceiverTexture(primary.shadowGenerator));
        expect(second.track.material.material._textureSlots.get("csmShadow")!.current).toBe(getCsmReceiverTexture(second.shadowGenerator));
        expect(getCsmReceiverTexture(second.shadowGenerator)).not.toBe(getCsmReceiverTexture(primary.shadowGenerator));
        // Separate GPU frame buffers, both fed from the shared spline source.
        expect(second.track.material.material._storageBufferSlots.get("trackFrames")!.current).not.toBe(
            primary.track.material.material._storageBufferSlots.get("trackFrames")!.current
        );
    });

    it("casts each pane's own track, the shared boulders and the shared ships", async () => {
        const worlds = await buildWorlds();
        const primary = worlds.primary;
        const second = worlds.secondary();
        const ships = [stubMesh("ship-pool-0")];

        setWorldCasters(primary, ships);
        setWorldCasters(second, ships);

        const primaryCasters = _getShadowTaskCasterMeshes(primary.shadowGenerator)!;
        const secondCasters = _getShadowTaskCasterMeshes(second.shadowGenerator)!;
        expect([...primaryCasters]).toEqual([primary.track.mesh, ...primary.rocks.pool.meshes, ...ships]);
        expect([...secondCasters]).toEqual([second.track.mesh, ...second.rocks.pool.meshes, ...ships]);
        // Never the other pane's track: its materials are bound to the other pane's cascades.
        expect(primaryCasters).not.toContain(second.track.mesh);
        expect(secondCasters).not.toContain(primary.track.mesh);

        // Mode teardown drops the mode's ships so the cascades cannot reference disposed meshes.
        setWorldCasters(primary, []);
        setWorldCasters(second, []);
        expect([..._getShadowTaskCasterMeshes(primary.shadowGenerator)!]).toEqual([primary.track.mesh, ...primary.rocks.pool.meshes]);
        expect([..._getShadowTaskCasterMeshes(second.shadowGenerator)!]).toEqual([second.track.mesh, ...second.rocks.pool.meshes]);
    });

    it("puts only the pane's own generator in the pane's scene", async () => {
        const worlds = await buildWorlds();
        const second = worlds.secondary();
        const sceneA = modeScene();
        const sceneB = modeScene();
        addWorldToScene(sceneA, worlds.primary);
        addWorldToScene(sceneB, second);

        // The shadow task walks `scene.lights`, so this is what decides which cascades a pane renders.
        const generatorsOf = (scene: SceneContext): unknown[] => scene.lights.map((l) => l.shadowGenerator).filter(Boolean);
        expect(generatorsOf(sceneA)).toEqual([worlds.primary.shadowGenerator]);
        expect(generatorsOf(sceneB)).toEqual([second.shadowGenerator]);
    });
});
