import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The light factories are device-free and stay real. Only the scene-facing calls a light makes are
 * mocked, because the stand-in scene below is not a Lite scene context: `addToScene`,
 * `removeFromScene` (reached through `dispose`) and `rebuildSceneRenderables`, which the mesh-list
 * sync triggers and which the tests count.
 */
vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return { ...actual, addToScene: vi.fn(), removeFromScene: vi.fn(), rebuildSceneRenderables: vi.fn(() => Promise.resolve()) };
});

import { rebuildSceneRenderables } from "babylon-lite";
import { AreaLight, DirectionalLight, HemisphericLight, PointLight, RectAreaLight, SpotLight } from "../src/lights/lights";
import type { Light } from "../src/lights/lights";
import { Color3 } from "../src/math/color";
import { Vector3 } from "../src/math/vector";
import { Mesh, TransformNode } from "../src/meshes/meshes";
import type { AbstractMesh } from "../src/meshes/meshes";
import type { Scene } from "../src/scene/scene";

/**
 * The light wrappers forward to Babylon Lite's device-free light factories, so
 * their scalar/color proxying and the `setEnabled` visibility toggle can be
 * exercised under Node without a GPU. `setEnabled(false)` has no per-light flag
 * in Lite, so the wrapper zeroes the underlying intensity while preserving the
 * caller-visible value — this test pins that behaviour.
 */

describe("Light.setEnabled visibility toggle", () => {
    it("zeroes the Lite intensity when disabled and restores it when enabled", () => {
        const light = new DirectionalLight("d", new Vector3(0, -1, 0));
        light.intensity = 0.8;
        expect(light.intensity).toBeCloseTo(0.8);
        expect(light._lite.intensity).toBeCloseTo(0.8);

        light.setEnabled(false);
        expect(light.isEnabled()).toBe(false);
        // Caller-visible intensity is preserved; the Lite light contributes nothing.
        expect(light.intensity).toBeCloseTo(0.8);
        expect(light._lite.intensity).toBe(0);

        light.setEnabled(true);
        expect(light.isEnabled()).toBe(true);
        expect(light.intensity).toBeCloseTo(0.8);
        expect(light._lite.intensity).toBeCloseTo(0.8);
    });

    it("remembers intensity changes made while disabled", () => {
        const light = new PointLight("p", new Vector3(0, 1, 0));
        light.intensity = 1;
        light.setEnabled(false);
        expect(light._lite.intensity).toBe(0);

        light.intensity = 2.5;
        // Still contributes nothing while disabled, but the value is remembered.
        expect(light._lite.intensity).toBe(0);
        expect(light.intensity).toBeCloseTo(2.5);

        light.setEnabled(true);
        expect(light._lite.intensity).toBeCloseTo(2.5);
    });

    it("is idempotent for repeated toggles of the same state", () => {
        const light = new SpotLight("s", new Vector3(0, 5, 0), new Vector3(0, -1, 0), Math.PI / 4, 2);
        light.intensity = 0.5;
        light.setEnabled(false);
        light.setEnabled(false);
        expect(light._lite.intensity).toBe(0);
        expect(light.intensity).toBeCloseTo(0.5);
        light.setEnabled(true);
        expect(light._lite.intensity).toBeCloseTo(0.5);
    });

    it("supports the hemispheric light too", () => {
        const light = new HemisphericLight("h", new Vector3(0, 1, 0));
        light.intensity = 0.7;
        light.setEnabled(false);
        expect(light._lite.intensity).toBe(0);
        light.setEnabled(true);
        expect(light._lite.intensity).toBeCloseTo(0.7);
    });

    it("inherits parent state without overwriting its local enabled flag", () => {
        const parent = new TransformNode("parent");
        const light = new DirectionalLight("d", new Vector3(0, -1, 0));
        light.intensity = 0.8;
        light.parent = parent;

        parent.setEnabled(false);
        expect(light.isEnabled(false)).toBe(true);
        expect(light.isEnabled()).toBe(false);
        expect(light.intensity).toBeCloseTo(0.8);
        expect(light._lite.intensity).toBe(0);

        light.setEnabled(false);
        parent.setEnabled(true);
        expect(light.isEnabled(false)).toBe(false);
        expect(light._lite.intensity).toBe(0);

        light.setEnabled(true);
        expect(light._lite.intensity).toBeCloseTo(0.8);
    });
});

describe("Light intensity writes bump the Lite light version", () => {
    // Lite's shared lights-UBO refresh is gated on the sum of each light's
    // `_lightVersion`; factory lights don't bump it on scalar `intensity` writes,
    // so the wrapper must, or intensity/enable changes never reach the GPU.
    function lightVersion(light: { _lite: unknown }): number {
        return (light._lite as { _lightVersion?: number })._lightVersion ?? 0;
    }

    it("advances _lightVersion on an intensity change", () => {
        const light = new DirectionalLight("d", new Vector3(0, -1, 0));
        const before = lightVersion(light);
        light.intensity = 0.4;
        expect(lightVersion(light)).toBeGreaterThan(before);
    });

    it("advances _lightVersion on setEnabled(false) then setEnabled(true)", () => {
        const light = new PointLight("p", new Vector3(1, 1, 1));
        light.intensity = 1;
        const afterIntensity = lightVersion(light);
        light.setEnabled(false);
        expect(lightVersion(light)).toBeGreaterThan(afterIntensity);
        const afterDisable = lightVersion(light);
        light.setEnabled(true);
        expect(lightVersion(light)).toBeGreaterThan(afterDisable);
    });

    it("advances _lightVersion for the spot light too", () => {
        const light = new SpotLight("s", new Vector3(0, 0, 0), new Vector3(0, -1, 0), Math.PI / 4, 2);
        const before = lightVersion(light);
        light.intensity = 3;
        expect(lightVersion(light)).toBeGreaterThan(before);
    });
});

describe("Light vectors and colours are live objects, as in Babylon.js", () => {
    // Babylon.js hands out the light's own Vector3 / Color3, and apps edit them in place
    // (`sun.direction.set(...)`, `fill.specular.copyFrom(Color3.Black())`). The getters used to return
    // copies, so those edits were silently dropped and the light kept its constructor values.
    function lightVersion(light: { _lite: unknown }): number {
        return (light._lite as { _lightVersion?: number })._lightVersion ?? 0;
    }

    it("writes an in-place direction edit through to the Lite light", () => {
        const sun = new DirectionalLight("sun", new Vector3(3, -2, 3));
        sun.direction.set(2.2, -3, 1.6);
        expect([sun._lite.direction.x, sun._lite.direction.y, sun._lite.direction.z]).toEqual([2.2, -3, 1.6]);
        sun.direction.y = -1;
        expect(sun._lite.direction.y).toBe(-1);
        // Same object on every read, and it keeps tracking the Lite vector.
        expect(sun.direction).toBe(sun.direction);
        sun._lite.direction.set(0, -1, 0);
        expect(sun.direction.y).toBe(-1);
        expect(sun.direction.x).toBe(0);
    });

    describe("RectAreaLight", () => {
        it("forwards the Babylon.js constructor and mutable light properties", () => {
            const light = new RectAreaLight("panel", new Vector3(1, 2, 3), 6, 4);

            expect(light.getClassName()).toBe("RectAreaLight");
            expect(light.getTypeID()).toBe(4);
            expect(light).toBeInstanceOf(AreaLight);
            expect([light.position.x, light.position.y, light.position.z]).toEqual([1, 2, 3]);
            expect(light.width).toBe(6);
            expect(light.height).toBe(4);

            light.width = 8;
            light.height = 5;
            light.diffuse = new Color3(0.2, 0.4, 0.6);
            light.specular.set(0.1, 0.3, 0.5);

            expect(light._lite.width).toBe(8);
            expect(light._lite.height).toBe(5);
            expect(light._lite.diffuse).toEqual([0.2, 0.4, 0.6]);
            expect(light._lite.specular).toEqual([0.1, 0.3, 0.5]);
        });

        it("parents the native emitter while preserving its local position", () => {
            const parent = new TransformNode("panel");
            const light = new RectAreaLight("light", Vector3.Zero(), 2, 3);

            light.parent = parent;

            expect(light._lite.parent).toBe(parent._node);
            expect([light._lite.position.x, light._lite.position.y, light._lite.position.z]).toEqual([0, 0, 0]);
        });
    });

    it("writes an in-place position edit through for directional, point and spot lights", () => {
        const lights = [
            new DirectionalLight("d", new Vector3(0, -1, 0)),
            new PointLight("p", new Vector3(0, 0, 0)),
            new SpotLight("s", new Vector3(0, 0, 0), new Vector3(0, -1, 0), Math.PI / 4, 2),
        ];
        for (const light of lights) {
            light.position.set(1, 2, 3);
            expect([light._lite.position.x, light._lite.position.y, light._lite.position.z]).toEqual([1, 2, 3]);
        }
    });

    it("writes in-place colour edits through and publishes them to the lights UBO", () => {
        const fill = new HemisphericLight("fill", new Vector3(0, 1, 0));
        const before = lightVersion(fill);
        fill.specular.copyFrom(new Color3(0, 0, 0));
        fill.groundColor.set(0.1, 0.2, 0.3);
        fill.diffuse.r = 0.5;
        expect(fill._lite.specularColor).toEqual([0, 0, 0]);
        expect(fill._lite.groundColor).toEqual([0.1, 0.2, 0.3]);
        expect(fill._lite.diffuseColor[0]).toBe(0.5);
        // A tuple write cannot notify Lite, so the wrapper has to bump the version itself.
        expect(lightVersion(fill)).toBeGreaterThan(before);
        expect(fill.diffuse).toBe(fill.diffuse);

        const sun = new DirectionalLight("sun", new Vector3(0, -1, 0));
        const sunBefore = lightVersion(sun);
        sun.diffuse = new Color3(1, 0.9, 0.8);
        expect(sun._lite.diffuse).toEqual([1, 0.9, 0.8]);
        expect(lightVersion(sun)).toBeGreaterThan(sunBefore);
    });
});

/**
 * Babylon.js filters per-mesh lighting with two arrays of meshes, and Lite filters with two sets of
 * meshes on the light (`LightBase.excludedMeshes` / `includedOnlyMeshes`, read by `affectsMesh`).
 * These tests pin what reaches those sets, and when a published change forces the renderables that
 * baked the old selection to be rebuilt. What the sets then mean for a mesh is pinned natively, in
 * `tests/lite/unit/mesh-light-selection.test.ts`.
 */
describe("Light.excludedMeshes / includedOnlyMeshes", () => {
    const rebuildMock = vi.mocked(rebuildSceneRenderables);

    beforeEach(() => {
        rebuildMock.mockClear();
    });

    /** A compat mesh over a bare Lite mesh: selection is by object, so no geometry is needed. */
    function mesh(name: string, liteId?: string): AbstractMesh {
        return Mesh._fromLite({ name, children: [], ...(liteId === undefined ? {} : { id: liteId }) } as never);
    }

    type LateWork = () => Promise<void>;
    /** A scene stand-in that also collects the engine's late work, so a test can run startup's tail. */
    type SceneStub = Scene & { _lateWork: LateWork[] };

    /**
     * Minimal compat-`Scene` stand-in: the light needs registration, `_lite` and the started flag.
     * `built` is the native `_built`, false only inside the window where the scene has started but
     * `registerScene` is still building its groups.
     */
    function sceneStub(started: boolean, built = true): SceneStub {
        const lateWork: LateWork[] = [];
        return {
            _hasStarted: started,
            _lite: { id: "scene-lite", _built: built, lights: [], _disposables: [] },
            _registerLight: vi.fn(),
            _unregisterNode: vi.fn(),
            getEngine: () => ({
                _registerLateWork: (work: LateWork) => {
                    lateWork.push(work);
                },
            }),
            _lateWork: lateWork,
        } as unknown as SceneStub;
    }

    function markBuilt(scene: SceneStub): void {
        (scene._lite as unknown as { _built: boolean })._built = true;
    }

    /** Tear the scene down the way `disposeScene` does, without touching its lights. */
    function disposeSceneStub(scene: SceneStub): void {
        const disposables = (scene._lite as unknown as { _disposables: (() => void)[] })._disposables;
        disposables.splice(0).forEach((dispose) => dispose());
    }

    /**
     * `splice` the way JS callers reach it.
     */
    function spliceFromJs(list: AbstractMesh[], ...args: unknown[]): AbstractMesh[] {
        return (list.splice as unknown as (...a: unknown[]) => AbstractMesh[]).call(list, ...args);
    }

    /** The sync is coalesced onto the microtask queue, so let it run. */
    async function flush(): Promise<void> {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
    }

    function excluded(light: Light): unknown[] | undefined {
        const meshes = light._lite.excludedMeshes;
        return meshes && [...meshes];
    }

    function includedOnly(light: Light): unknown[] | undefined {
        const meshes = light._lite.includedOnlyMeshes;
        return meshes && [...meshes];
    }

    it("starts empty, as Babylon.js does, and publishes no sets", () => {
        const rim = new DirectionalLight("rim", new Vector3(-2.2, -1.2, -1.6));
        expect(rim.excludedMeshes).toEqual([]);
        expect(rim.includedOnlyMeshes).toEqual([]);
        // Empty lists stay unpublished so `affectsMesh` keeps its "no lists" fast path.
        expect(excluded(rim)).toBeUndefined();
        expect(includedOnly(rim)).toBeUndefined();
    });

    it("publishes an assigned exclusion list as Lite meshes", async () => {
        const rim = new DirectionalLight("rim", new Vector3(-2.2, -1.2, -1.6));
        const floor = mesh("floor");
        const wall = mesh("wall");

        rim.excludedMeshes = [floor, wall];
        await flush();

        expect(excluded(rim)).toEqual([floor._lite, wall._lite]);
        expect(includedOnly(rim)).toBeUndefined();
    });

    it("publishes an in-place push, the case a mesh-added callback drives", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        const floor = mesh("floor");
        rim.excludedMeshes = [floor];
        await flush();

        const ceiling = mesh("ceiling");
        rim.excludedMeshes.push(ceiling);
        await flush();

        expect(excluded(rim)).toEqual([floor._lite, ceiling._lite]);
    });

    it("publishes a splice removal, so a mesh taken off the list is lit again", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        const floor = mesh("floor");
        const wall = mesh("wall");
        rim.excludedMeshes = [floor, wall];
        await flush();

        const removed = rim.excludedMeshes.splice(0, 1);
        await flush();

        expect(removed).toEqual([floor]);
        expect(excluded(rim)).toEqual([wall._lite]);
    });

    it("hands out a stable array that keeps publishing after a reassignment", async () => {
        const led = new SpotLight("led", new Vector3(0, 1, 0), new Vector3(0, -1, 0), Math.PI / 4, 2);
        expect(led.includedOnlyMeshes).toBe(led.includedOnlyMeshes);

        const door = mesh("door");
        led.includedOnlyMeshes = [];
        const list = led.includedOnlyMeshes;
        list.push(door);
        await flush();

        // The freshly assigned array is hooked too, not just the one built in the constructor.
        expect(includedOnly(led)).toEqual([door._lite]);
    });

    it("drops the published set again once a list is emptied", async () => {
        const rim = new PointLight("rim", new Vector3(0, 2, 0));
        const floor = mesh("floor");
        rim.excludedMeshes = [floor];
        await flush();
        expect(excluded(rim)).toHaveLength(1);

        rim.excludedMeshes.splice(0, 1);
        await flush();

        expect(excluded(rim)).toBeUndefined();
    });

    it("never writes to a mesh's Lite id, so a loaded light list keeps matching", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        const loaded = mesh("floor", "floor-node-7");
        const procedural = mesh("box");

        rim.excludedMeshes = [loaded, procedural];
        await flush();

        // `.babylon` light lists are keyed on the node id, so the id a mesh was loaded with has to
        // survive being put in a compat list, and a mesh without one must not acquire one.
        expect(loaded._lite.id).toBe("floor-node-7");
        expect(procedural._lite.id).toBeUndefined();
        expect(excluded(rim)).toEqual([loaded._lite, procedural._lite]);
    });

    it("keeps two meshes that share a loader id independently selectable", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        // Importing one asset twice yields distinct meshes carrying the same asset-local id.
        const firstImport = mesh("floor", "floor-node-7");
        const secondImport = mesh("floor", "floor-node-7");

        rim.excludedMeshes = [firstImport];
        await flush();

        expect(excluded(rim)).toEqual([firstImport._lite]);
        expect(excluded(rim)).not.toContain(secondImport._lite);
    });

    it("keeps same-named meshes independent, because Babylon.js matches by identity", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        const left = mesh("wall");
        const right = mesh("wall");

        rim.excludedMeshes = [left];
        await flush();

        expect(excluded(rim)).toEqual([left._lite]);
        expect(excluded(rim)).not.toContain(right._lite);
    });

    it("publishes both lists as they are, leaving the precedence to affectsMesh", async () => {
        const led = new SpotLight("led", new Vector3(0, 1, 0), new Vector3(0, -1, 0), Math.PI / 4, 2);
        const carcass = mesh("carcass");
        const glassDoor = mesh("glassDoor");

        led.includedOnlyMeshes = [carcass, glassDoor];
        led.excludedMeshes = [glassDoor];
        await flush();

        // `affectsMesh` applies the inclusion and then subtracts the exclusion, so neither list is
        // folded into the other here. An inclusion fully cancelled by an exclusion still lights
        // nothing, which no empty set could express.
        expect(includedOnly(led)).toEqual([carcass._lite, glassDoor._lite]);
        expect(excluded(led)).toEqual([glassDoor._lite]);
    });

    it("rebuilds the renderables that baked the old selection, once per tick", async () => {
        const scene = sceneStub(true);
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);

        rim.excludedMeshes = [mesh("floor")];
        rim.excludedMeshes.push(mesh("wall"));
        rim.excludedMeshes.push(mesh("ceiling"));
        await flush();

        // Building a list mesh by mesh must cost one rebuild, not one per mesh.
        expect(rebuildMock).toHaveBeenCalledTimes(1);
        expect(rebuildMock).toHaveBeenCalledWith(scene._lite);
    });

    it("shares one scene rebuild across lights edited in the same tick", async () => {
        const scene = sceneStub(true);
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);
        const led = new SpotLight("led", new Vector3(0, 1, 0), new Vector3(0, -1, 0), Math.PI / 4, 2, scene);

        rim.excludedMeshes = [mesh("floor")];
        led.includedOnlyMeshes = [mesh("door")];
        await flush();

        // A rebuild rescans every material group and recreates every mesh's GPU resources, and both
        // lights have published by the time it runs, so one is enough for the whole update.
        expect(rebuildMock).toHaveBeenCalledTimes(1);
        expect(rebuildMock).toHaveBeenCalledWith(scene._lite);
    });

    it("holds the rebuild across the initial-build window instead of dropping it", async () => {
        // `_hasStarted` is already true while `registerScene` is still building material groups, and
        // a rebuild is a no-op until `_built`. Requesting one here would be discarded, leaving a
        // group that baked its light indices early lit by a light that no longer reaches it.
        const scene = sceneStub(true, false);
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);
        const floor = mesh("floor");

        rim.excludedMeshes = [floor];
        await flush();

        // Published immediately, so a group built after this point bakes the new selection.
        expect(excluded(rim)).toEqual([floor._lite]);
        expect(rebuildMock).not.toHaveBeenCalled();
        expect(scene._lateWork).toHaveLength(1);

        markBuilt(scene);
        await scene._lateWork[0]!();

        // One rebuild once the scene is built, which rebakes the groups built during the window.
        expect(rebuildMock).toHaveBeenCalledTimes(1);
        expect(rebuildMock).toHaveBeenCalledWith(scene._lite);
    });

    it("holds one rebuild for every edit made inside the initial-build window", async () => {
        const scene = sceneStub(true, false);
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);
        const led = new SpotLight("led", new Vector3(0, 1, 0), new Vector3(0, -1, 0), Math.PI / 4, 2, scene);

        rim.excludedMeshes = [mesh("floor")];
        await flush();
        led.includedOnlyMeshes = [mesh("door")];
        await flush();
        rim.excludedMeshes.push(mesh("wall"));
        await flush();

        expect(scene._lateWork).toHaveLength(1);

        markBuilt(scene);
        await scene._lateWork[0]!();
        expect(rebuildMock).toHaveBeenCalledTimes(1);
    });

    it("rebuilds on the tick again once the window has passed", async () => {
        const scene = sceneStub(true, false);
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);

        rim.excludedMeshes = [mesh("floor")];
        await flush();
        markBuilt(scene);
        await scene._lateWork[0]!();
        rebuildMock.mockClear();

        // A later edit is past the window, so it takes the normal per-tick path, not late work.
        rim.excludedMeshes = [mesh("wall")];
        await flush();

        expect(scene._lateWork).toHaveLength(1);
        expect(rebuildMock).toHaveBeenCalledTimes(1);
    });

    it("does not rebuild before the scene has started, or without a scene", async () => {
        const pending = new DirectionalLight("rim", new Vector3(0, -1, 0), sceneStub(false));
        const floor = mesh("floor");
        pending.excludedMeshes = [floor];
        await flush();

        // The boot-time build reads the sets, so there is nothing to rebuild yet.
        expect(excluded(pending)).toEqual([floor._lite]);
        expect(rebuildMock).not.toHaveBeenCalled();

        const detached = new DirectionalLight("detached", new Vector3(0, -1, 0));
        detached.excludedMeshes = [mesh("wall")];
        await flush();
        expect(rebuildMock).not.toHaveBeenCalled();
    });

    it("hooks an array once per light, however often it is reassigned", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        const floor = mesh("floor");
        const list = [floor];

        rim.excludedMeshes = list;
        const hookedPush = list.push;
        const hookedSplice = list.splice;

        for (let i = 0; i < 1000; i++) {
            const current = rim.excludedMeshes;
            rim.excludedMeshes = current;
            rim.excludedMeshes = list;
        }
        expect(list.push).toBe(hookedPush);
        expect(list.splice).toBe(hookedSplice);
        await flush();

        const wall = mesh("wall");
        rim.excludedMeshes.push(wall);
        rim.excludedMeshes.splice(0, 1);
        await flush();

        expect(rim.excludedMeshes).toBe(list);
        expect(rim.excludedMeshes).toEqual([wall]);
        expect(excluded(rim)).toEqual([wall._lite]);
    });

    it("still hooks an array shared with a second light, so both publish", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        const led = new SpotLight("led", new Vector3(0, 1, 0), new Vector3(0, -1, 0), Math.PI / 4, 2);
        const shared = [mesh("floor")];

        rim.excludedMeshes = shared;
        led.excludedMeshes = shared;
        await flush();

        const wall = mesh("wall");
        shared.push(wall);
        await flush();

        // Skipping the second hook because the array was already hooked would leave this light
        // publishing a stale set.
        expect(excluded(rim)).toEqual(shared.map((m) => m._lite));
        expect(excluded(led)).toEqual(shared.map((m) => m._lite));
    });

    it("stops publishing from a list it no longer holds", async () => {
        const scene = sceneStub(true);
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);
        const retired = [mesh("floor")];

        rim.excludedMeshes = retired;
        await flush();
        rim.excludedMeshes = [mesh("door")];
        await flush();
        rebuildMock.mockClear();

        // The application still owns the old array; mutating it must no longer reach this light.
        retired.push(mesh("wall"));
        await flush();

        expect(rim.excludedMeshes.map((m) => m.name)).toEqual(["door"]);
        expect(excluded(rim)).toEqual([rim.excludedMeshes[0]!._lite]);
        expect(rebuildMock).not.toHaveBeenCalled();
    });

    it("stops publishing once disposed, so a retained list releases it", async () => {
        const scene = sceneStub(true);
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);
        const moduleMeshes = [mesh("floor")];

        rim.excludedMeshes = moduleMeshes;
        await flush();
        rim.dispose();
        rebuildMock.mockClear();

        // A configurator that swaps modules keeps this array and drops the light. Scheduling a sync,
        // and a scene rebuild, for a disposed light is work nothing reads.
        moduleMeshes.push(mesh("wall"));
        await flush();

        expect(rebuildMock).not.toHaveBeenCalled();
    });

    it("keeps a surviving light publishing when another moves off their shared list", async () => {
        const scene = sceneStub(true);
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);
        const led = new SpotLight("led", new Vector3(0, 1, 0), new Vector3(0, -1, 0), Math.PI / 4, 2, scene);
        const shared = [mesh("floor")];

        rim.excludedMeshes = shared;
        led.excludedMeshes = shared;
        await flush();

        // `rim` moves to its own list; `led` still holds the shared one.
        rim.excludedMeshes = [mesh("door")];
        await flush();

        const wall = mesh("wall");
        shared.push(wall);
        await flush();

        // Releasing `rim` from the array must leave `led` subscribed to it.
        expect(excluded(led)).toEqual(shared.map((m) => m._lite));
        expect(excluded(rim)).toEqual([rim.excludedMeshes[0]!._lite]);
    });

    it("keeps a surviving light publishing when a light sharing its list is disposed", async () => {
        const scene = sceneStub(true);
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);
        const led = new SpotLight("led", new Vector3(0, 1, 0), new Vector3(0, -1, 0), Math.PI / 4, 2, scene);
        const shared = [mesh("floor")];

        rim.excludedMeshes = shared;
        led.excludedMeshes = shared;
        await flush();
        rim.dispose();

        const wall = mesh("wall");
        shared.push(wall);
        await flush();

        // Releasing one light must not take the array's other live consumers with it.
        expect(excluded(led)).toEqual(shared.map((m) => m._lite));
    });

    it("releases a retained list when the scene is disposed without disposing its lights", async () => {
        const scene = sceneStub(true);
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);
        const moduleMeshes = [mesh("floor")];

        rim.excludedMeshes = moduleMeshes;
        await flush();

        // `scene.dispose()` never reaches `_disposeSelf`, so the light is still live here.
        disposeSceneStub(scene);
        rebuildMock.mockClear();

        const wall = mesh("wall");
        moduleMeshes.push(wall);
        await flush();

        // Nothing reads a dead scene's selection, and the array must not retain the light that held it.
        expect(rebuildMock).not.toHaveBeenCalled();
        expect(excluded(rim)).toEqual([moduleMeshes[0]!._lite]);
    });

    it("keeps a live scene's light publishing when a disposed scene shared its list", async () => {
        const retired = sceneStub(true);
        const current = sceneStub(true);
        const old = new DirectionalLight("old", new Vector3(0, -1, 0), retired);
        const led = new SpotLight("led", new Vector3(0, 1, 0), new Vector3(0, -1, 0), Math.PI / 4, 2, current);
        const shared = [mesh("floor")];

        old.excludedMeshes = shared;
        led.excludedMeshes = shared;
        await flush();

        disposeSceneStub(retired);

        const wall = mesh("wall");
        shared.push(wall);
        await flush();

        // Only the retired scene's light comes off the array; the live scene keeps observing it.
        expect(excluded(led)).toEqual(shared.map((m) => m._lite));
        expect(excluded(old)).toEqual([shared[0]!._lite]);
    });

    it("survives repeated create, dispose and reuse against one retained list", async () => {
        const scene = sceneStub(true);
        const moduleMeshes = [mesh("floor")];
        const hookedPush = (() => {
            const first = new DirectionalLight("probe", new Vector3(0, -1, 0), scene);
            first.excludedMeshes = moduleMeshes;
            first.dispose();
            return moduleMeshes.push;
        })();

        for (let i = 0; i < 500; i++) {
            const light = new DirectionalLight(`module-${i}`, new Vector3(0, -1, 0), scene);
            light.excludedMeshes = moduleMeshes;
            light.dispose();
        }
        // One wrapper for the array's whole lifetime, however many lights pass through it.
        expect(moduleMeshes.push).toBe(hookedPush);

        const live = new DirectionalLight("live", new Vector3(0, -1, 0), scene);
        live.excludedMeshes = moduleMeshes;
        await flush();
        rebuildMock.mockClear();

        const wall = mesh("wall");
        moduleMeshes.push(wall);
        await flush();

        // Only the one live light publishes, and it does so exactly once.
        expect(excluded(live)).toEqual(moduleMeshes.map((m) => m._lite));
        expect(rebuildMock).toHaveBeenCalledTimes(1);
    });

    it("keeps Array.splice semantics for an omitted and an explicitly undefined deleteCount", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        const floor = mesh("floor");
        const wall = mesh("wall");
        rim.excludedMeshes = [floor, wall];
        await flush();

        // `splice(0, undefined, mesh)` inserts without deleting, as it does on a plain array.
        const inserted = mesh("ceiling");
        expect(spliceFromJs(rim.excludedMeshes, 0, undefined, inserted)).toEqual([]);
        await flush();
        expect(rim.excludedMeshes).toEqual([inserted, floor, wall]);
        expect(excluded(rim)).toEqual([inserted._lite, floor._lite, wall._lite]);

        // ...and `splice()` removes nothing at all.
        expect(spliceFromJs(rim.excludedMeshes)).toEqual([]);
        await flush();
        expect(rim.excludedMeshes).toHaveLength(3);
        expect(excluded(rim)).toHaveLength(3);
    });

    it("does not rebuild for a light held by a clustered container", async () => {
        const scene = sceneStub(true);
        const led = new PointLight("led", new Vector3(0, 1, 0), scene);
        led._clusteredContainer = { id: "container" };

        const door = mesh("door");
        led.includedOnlyMeshes = [door];
        await flush();

        // The container takes the light out of the per-mesh light path, so no renderable reads the
        // sets, but they are still kept current for the moment the light is returned to the scene.
        expect(includedOnly(led)).toEqual([door._lite]);
        expect(rebuildMock).not.toHaveBeenCalled();
    });
});
