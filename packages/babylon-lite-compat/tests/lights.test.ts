import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The light factories are device-free and stay real. Only the two scene-facing calls a light makes
 * are mocked: `addToScene` (the stand-in scene below is not a Lite scene context) and
 * `rebuildSceneRenderables`, which the mesh-list sync triggers and which the tests count.
 */
vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return { ...actual, addToScene: vi.fn(), rebuildSceneRenderables: vi.fn(() => Promise.resolve()) };
});

import { rebuildSceneRenderables } from "babylon-lite";
import { DirectionalLight, HemisphericLight, PointLight, SpotLight } from "../src/lights/lights";
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
 * Babylon.js filters per-mesh lighting with two arrays of meshes; Lite filters with two sets of mesh
 * ids (`LightBase.excludedMeshIds` / `includedOnlyMeshIds`, read by `affectsMesh`). These tests pin
 * the translation: which ids are published, when a mesh is given one, and when the published change
 * forces the renderables that baked the old selection to be rebuilt.
 */
describe("Light.excludedMeshes / includedOnlyMeshes", () => {
    const rebuildMock = vi.mocked(rebuildSceneRenderables);

    beforeEach(() => {
        rebuildMock.mockClear();
    });

    /** A compat mesh over a bare Lite mesh — no GPU geometry is needed to carry an id. */
    function mesh(name: string, liteId?: string): AbstractMesh {
        return Mesh._fromLite({ name, children: [], ...(liteId === undefined ? {} : { id: liteId }) } as never);
    }

    /** Minimal compat-`Scene` stand-in: the light only needs registration, `_lite` and the started flag. */
    function sceneStub(started: boolean): Scene {
        return { _hasStarted: started, _lite: { id: "scene-lite" }, _registerLight: vi.fn(), _unregisterNode: vi.fn() } as unknown as Scene;
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

    function excluded(light: { _lite: { excludedMeshIds?: ReadonlySet<string> } }): string[] | undefined {
        const ids = light._lite.excludedMeshIds;
        return ids && [...ids];
    }

    function includedOnly(light: { _lite: { includedOnlyMeshIds?: ReadonlySet<string> } }): string[] | undefined {
        const ids = light._lite.includedOnlyMeshIds;
        return ids && [...ids];
    }

    it("starts empty, as Babylon.js does, and publishes no sets", () => {
        const rim = new DirectionalLight("rim", new Vector3(-2.2, -1.2, -1.6));
        expect(rim.excludedMeshes).toEqual([]);
        expect(rim.includedOnlyMeshes).toEqual([]);
        // Empty lists stay unpublished so `affectsMesh` keeps its "no lists" fast path.
        expect(excluded(rim)).toBeUndefined();
        expect(includedOnly(rim)).toBeUndefined();
    });

    it("publishes an assigned exclusion list as Lite mesh ids", async () => {
        const rim = new DirectionalLight("rim", new Vector3(-2.2, -1.2, -1.6));
        const floor = mesh("floor");
        const wall = mesh("wall");

        rim.excludedMeshes = [floor, wall];
        await flush();

        expect(excluded(rim)).toEqual([floor._lite.id, wall._lite.id]);
        expect(floor._lite.id).toBeTruthy();
        expect(includedOnly(rim)).toBeUndefined();
    });

    it("publishes an in-place push, the case a mesh-added observable drives", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        const floor = mesh("floor");
        rim.excludedMeshes = [floor];
        await flush();

        const ceiling = mesh("ceiling");
        rim.excludedMeshes.push(ceiling);
        await flush();

        expect(excluded(rim)).toEqual([floor._lite.id, ceiling._lite.id]);
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
        expect(excluded(rim)).toEqual([wall._lite.id]);
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
        expect(includedOnly(led)).toEqual([door._lite.id]);
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

    it("gives same-named meshes distinct ids, because Babylon.js matches by identity", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        const left = mesh("wall");
        const right = mesh("wall");

        rim.excludedMeshes = [left];
        await flush();

        // Excluding one "wall" must not darken the other, so the id cannot be the name.
        expect(left._lite.id).not.toBe(right._lite.id);
        expect(excluded(rim)).toEqual([left._lite.id]);
        expect(excluded(rim)).not.toContain(right._lite.id);
    });

    it("keeps an id the mesh already carries, so loaded light lists still match", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        const loaded = mesh("floor", "floor-node-7");

        rim.excludedMeshes = [loaded];
        await flush();

        expect(loaded._lite.id).toBe("floor-node-7");
        expect(excluded(rim)).toEqual(["floor-node-7"]);
    });

    it("lets an exclusion subtract from an inclusion, as Babylon.js canAffectMesh does", async () => {
        const led = new SpotLight("led", new Vector3(0, 1, 0), new Vector3(0, -1, 0), Math.PI / 4, 2);
        const carcass = mesh("carcass");
        const shelf = mesh("shelf");
        const glassDoor = mesh("glassDoor");

        led.includedOnlyMeshes = [carcass, shelf, glassDoor];
        led.excludedMeshes = [glassDoor];
        await flush();

        // Lite's affectsMesh stops at a non-empty included set, so the subtraction happens here.
        expect(includedOnly(led)).toEqual([carcass._lite.id, shelf._lite.id]);
        expect(excluded(led)).toBeUndefined();
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

    it("does not rebuild before the scene has started, or without a scene", async () => {
        const pending = new DirectionalLight("rim", new Vector3(0, -1, 0), sceneStub(false));
        const floor = mesh("floor");
        pending.excludedMeshes = [floor];
        await flush();

        // The boot-time build reads the sets, so there is nothing to rebuild yet.
        expect(excluded(pending)).toEqual([floor._lite.id]);
        expect(rebuildMock).not.toHaveBeenCalled();

        const detached = new DirectionalLight("detached", new Vector3(0, -1, 0));
        detached.excludedMeshes = [mesh("wall")];
        await flush();
        expect(rebuildMock).not.toHaveBeenCalled();
    });

    it("keeps the restriction active when every included mesh is also excluded", async () => {
        const led = new SpotLight("led", new Vector3(0, 1, 0), new Vector3(0, -1, 0), Math.PI / 4, 2);
        const box = mesh("box");
        const other = mesh("other");

        led.includedOnlyMeshes = [box];
        led.excludedMeshes = [box];
        await flush();

        // Babylon.js lights nothing here.
        const ids = includedOnly(led);
        expect(ids).toHaveLength(1);
        expect(ids).not.toContain(box._lite.id);
        expect(ids).not.toContain(other._lite.id);
        expect(excluded(led)).toBeUndefined();
    });

    it("scopes a clone separately from the source it inherited a filter id from", async () => {
        const rim = new DirectionalLight("rim", new Vector3(0, -1, 0));
        const source = mesh("panel");

        rim.excludedMeshes = [source];
        await flush();
        const sourceId = source._lite.id;
        expect(sourceId).toBeTruthy();

        // `cloneMeshNode` builds the clone by spreading the source mesh, so the clone starts out
        // carrying the id that was just minted for the source.
        const clone = mesh("panel", sourceId);
        rim.excludedMeshes = [clone];
        await flush();

        // Listing only the clone must not darken the source as well.
        expect(clone._lite.id).not.toBe(sourceId);
        expect(excluded(rim)).toEqual([clone._lite.id]);
        expect(excluded(rim)).not.toContain(sourceId);
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
        expect(excluded(rim)).toEqual([inserted._lite.id, floor._lite.id, wall._lite.id]);

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
        // sets — but they are still kept current for the moment the light is returned to the scene.
        expect(includedOnly(led)).toEqual([door._lite.id]);
        expect(rebuildMock).not.toHaveBeenCalled();
    });
});
