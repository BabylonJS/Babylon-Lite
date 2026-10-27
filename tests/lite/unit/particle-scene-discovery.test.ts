import { describe, expect, it } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";
import type { NodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { getParticleSystems, registerNodeParticleSet } from "../../../packages/babylon-lite/src/particle/particle-scene";
import { createParticleSystem, isParticleSystemStarted } from "../../../packages/babylon-lite/src/particle/particle-system";
import { createSceneContext, disposeScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

function sceneFixture() {
    const engine = { _currentDelta: 1000 / 60 } as EngineContext;
    return createSceneContext({ engine, _renderingContexts: [] } as unknown as SurfaceContext, { defaultRenderTask: false });
}

function systemFixture() {
    const system = createParticleSystem(4);
    system.texture = { width: 1, height: 1 } as Texture2D;
    system.emitRate = 0;
    return system;
}

function setFixture(...systems: ReturnType<typeof systemFixture>[]): NodeParticleSet {
    return { systems, _graph: parseNodeParticleSource({ blocks: [{ customType: "BABYLON.SystemBlock", id: 1 }] }) };
}

describe("particle scene discovery", () => {
    it("lazily lists unique identities in registration order, including stopped systems", () => {
        const scene = sceneFixture();
        const empty = getParticleSystems(scene);
        expect(empty).toEqual([]);
        expect(getParticleSystems(scene)).not.toBe(empty);
        const first = systemFixture();
        const second = systemFixture();
        const third = systemFixture();
        registerNodeParticleSet(scene, setFixture(first, second), { autoStart: false });
        const live = getParticleSystems(scene);
        const disposables = scene._disposables.length;
        registerNodeParticleSet(scene, setFixture(second, third), { autoStart: false });
        expect(getParticleSystems(scene)).toBe(live);
        expect(live).toEqual([first, second, third]);
        expect(live.every((system) => !isParticleSystemStarted(system))).toBe(true);
        expect(scene._beforeRender).toHaveLength(4);
        // Two additional pick-source disposers, but only one enumeration disposer per scene.
        expect(scene._disposables).toHaveLength(disposables + 2);
        disposeScene(scene);
        expect(live).toEqual([]);
        expect(getParticleSystems(scene)).toEqual([]);
    });

    it("preserves duplicate rendering, autoStart, and callbacks interleaved with user callbacks", () => {
        const scene = sceneFixture();
        const first = systemFixture();
        const second = systemFixture();
        const events: string[] = [];
        first._prepareFrame = () => events.push("first");
        second._prepareFrame = () => events.push("second");
        registerNodeParticleSet(scene, setFixture(first, second));
        scene._beforeRender.push(() => events.push("user"));
        registerNodeParticleSet(scene, setFixture(first, second));
        expect(scene._beforeRender).toHaveLength(5);
        expect(scene._deferredBuilders).toHaveLength(4);
        expect(scene._pickSources).toHaveLength(4);
        expect(getParticleSystems(scene)).toEqual([first, second]);
        scene._update();
        expect(events).toEqual(["first", "second", "user", "first", "second"]);
        expect(isParticleSystemStarted(first)).toBe(true);
        disposeScene(scene);
    });

    it("preserves registration from inside a frame callback and isolates scenes", () => {
        const scene = sceneFixture();
        const other = sceneFixture();
        const first = systemFixture();
        const second = systemFixture();
        const events: string[] = [];
        first._prepareFrame = () => events.push("first");
        second._prepareFrame = () => events.push("second");
        registerNodeParticleSet(scene, setFixture(first));
        scene._beforeRender.push(() => {
            events.push("user");
            if (getParticleSystems(scene).length === 1) {
                registerNodeParticleSet(scene, setFixture(second));
            }
        });
        scene._update();
        expect(events).toEqual(["first", "user", "second"]);
        expect(getParticleSystems(scene)).toEqual([first, second]);
        expect(getParticleSystems(other)).toEqual([]);
        registerNodeParticleSet(other, setFixture(second), { autoStart: false });
        disposeScene(scene);
        expect(getParticleSystems(other)).toEqual([second]);
        disposeScene(other);
    });

    it("does not allocate discovery storage or a disposer for an empty set", () => {
        const scene = sceneFixture();
        const disposerCount = scene._disposables.length;
        registerNodeParticleSet(scene, setFixture());
        expect(getParticleSystems(scene)).toEqual([]);
        expect(scene._disposables).toHaveLength(disposerCount);
        expect(scene._beforeRender).toHaveLength(0);
        disposeScene(scene);
    });
});
