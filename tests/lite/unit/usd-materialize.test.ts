import { afterEach, describe, expect, it, vi } from "vitest";

import { goToFrame, playAnimation, stopAnimation, tickAnimationCore } from "../../../packages/babylon-lite/src/animation/animation-group";
import { AnimationGroupMaskMode, createAnimationGroupMask } from "../../../packages/babylon-lite/src/animation/animation-group-mask";
import { addAnimationGroup } from "../../../packages/babylon-lite/src/animation/animation-group-task";
import { clearAnimationManager, createAnimationManager, updateAnimationManager } from "../../../packages/babylon-lite/src/animation/animation-manager";
import { setAnimationWeight } from "../../../packages/babylon-lite/src/animation/animation-weight";
import { enableAnimationBlending } from "../../../packages/babylon-lite/src/animation/weighted-gltf-mixer";
import { disposeUsd } from "../../../packages/babylon-lite/src/loader-usd/load-usd";
import { materializeUsd } from "../../../packages/babylon-lite/src/loader-usd/usd-materialize";
import { getContainerMeshes } from "../../../packages/babylon-lite/src/asset-container";
import { createPbrMaterial, type PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { MaterialPlugin } from "../../../packages/babylon-lite/src/material/plugin/material-plugin";
import type { SceneNode } from "../../../packages/babylon-lite/src/scene/scene-node";
import { readUsdCommands, UsdOp, usdField } from "../../../packages/babylon-lite/src/loader-usd/usd-protocol";
import { usdFixture, usdTestContainer, usdTestEngine } from "./usd-fixture";
import { registerPbrPlugins } from "../../../packages/babylon-lite/src/material/plugin/pbr-plugin-bridge";
import type { PbrExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

afterEach(() => vi.restoreAllMocks());

async function collectGarbage(): Promise<void> {
    setFlagsFromString("--expose_gc");
    const collect = runInNewContext("gc") as () => void;
    try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (let attempt = 0; attempt < 20; attempt++) {
            collect();
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    } finally {
        setFlagsFromString("--no-expose_gc");
    }
}

describe("USD command materialization", () => {
    it("creates a hierarchy, compact material subsets and shared instance geometry", async () => {
        const fixture = usdFixture({ scale: 0.01 });
        const { engine, buffers } = usdTestEngine();
        const container = usdTestContainer(fixture);

        await materializeUsd(engine, fixture, container);
        const meshes = getContainerMeshes(container);
        expect(meshes).toHaveLength(4);
        expect(meshes.map((mesh) => mesh.name)).toEqual(["Fixture [0]", "Fixture [1]", "Fixture", "Fixture"]);
        expect(meshes.map((mesh) => mesh._gpu.indexCount)).toEqual([3, 3, 3, 3]);
        expect(meshes[2]!._gpu).toBe(meshes[0]!._gpu);
        expect(meshes[3]!._gpu).toBe(meshes[1]!._gpu);
        expect(meshes[0]!.worldMatrix[0]).toBeCloseTo(0.01);
        expect(meshes[2]!.worldMatrix[12]).toBeCloseTo(0.03);
        expect(meshes[0]!.boundMin).toEqual([0, 0, 0]);
        expect(meshes[0]!.boundMax).toEqual([1, 1, 0]);
        expect((meshes[0]!.material as PbrMaterialProps).name).toBe("Fixture");
        expect((meshes[0]!.material as PbrMaterialProps).metallicFactor).toBeCloseTo(0.4);
        expect((meshes[1]!.material as PbrMaterialProps).doubleSided).toBe(true);

        disposeUsd(container);
        expect(buffers.every((buffer) => vi.mocked(buffer.destroy).mock.calls.length === 1)).toBe(true);
        disposeUsd(container);
        expect(buffers.every((buffer) => vi.mocked(buffer.destroy).mock.calls.length === 1)).toBe(true);
    });

    it.each([0, 1, 2, 3])("creates and instances analytic primitive type %s", async (shape) => {
        const fixture = usdFixture({ analytic: shape, zUp: true });
        const { engine } = usdTestEngine();
        const container = usdTestContainer(fixture);

        await materializeUsd(engine, fixture, container);
        const meshes = getContainerMeshes(container);
        expect(meshes).toHaveLength(2);
        expect(meshes[0]!._gpu).toBe(meshes[1]!._gpu);
        expect(meshes[0]!._gpu.indexCount).toBeGreaterThan(0);
        expect(meshes[0]!.worldMatrix[5]).toBeCloseTo(0);
        expect(meshes[0]!.worldMatrix[6]).toBeCloseTo(1);
        expect(meshes[0]!.worldMatrix[9]).toBeCloseTo(1);
        disposeUsd(container);
    });

    it("preserves left-handed analytic winding and accepts the protocol default frame rate", async () => {
        const rightFixture = usdFixture({ analytic: 0, zeroFps: true });
        const leftFixture = usdFixture({ analytic: 0, leftHanded: true });
        const right = usdTestContainer(rightFixture);
        const left = usdTestContainer(leftFixture);
        const { engine } = usdTestEngine();

        await materializeUsd(engine, rightFixture, right);
        await materializeUsd(engine, leftFixture, left);
        const rightIndices = getContainerMeshes(right)[0]!._cpuIndices!;
        const leftIndices = getContainerMeshes(left)[0]!._cpuIndices!;
        expect(rightIndices.slice(0, 3)).toEqual(new Uint32Array([leftIndices[2]!, leftIndices[1]!, leftIndices[0]!]));
        disposeUsd(right);
        disposeUsd(left);
    });

    it("attaches eight-influence skins and converts USD time codes to stopped animation groups", async () => {
        const fixture = usdFixture({ skin: true });
        const { engine } = usdTestEngine();
        const container = usdTestContainer(fixture);

        await materializeUsd(engine, fixture, container);
        const meshes = getContainerMeshes(container);
        expect(meshes).toHaveLength(4);
        expect(meshes.every((mesh) => mesh.skeleton?.boneCount === 2)).toBe(true);
        expect(meshes.every((mesh) => mesh.skeleton?.joints1?.length === 12)).toBe(true);
        expect(meshes[2]!.skeleton).toBe(meshes[0]!.skeleton);
        expect(container.animationGroups).toHaveLength(1);
        expect(container.animationGroups![0]!.isPlaying).toBe(false);
        expect(container.animationGroups![0]!.duration).toBe(1);
        expect(container.animationGroups![0]!.targetedAnimations.map((track) => track.path)).toEqual(["matrix", "matrix"]);
        expect(meshes[0]!.skeleton!.boneMatrices[29]).toBeCloseTo(-1);

        playAnimation(container.animationGroups![0]!);
        vi.mocked(engine._device.queue.writeTexture).mockClear();
        goToFrame(container.animationGroups![0]!, 12, engine);
        expect((container.animationGroups![0]!.targetedAnimations[0]!.target as SceneNode).worldMatrix[12]).toBeCloseTo(1);
        expect(meshes[0]!.skeleton!.boneMatrices[28]).toBeCloseTo(0);
        expect(meshes[0]!.skeleton!.boneMatrices[29]).toBeCloseTo(0);
        expect(engine._device.queue.writeTexture).toHaveBeenCalled();
        expect(engine._device.queue.writeTexture).toHaveBeenCalledTimes(2);
        vi.mocked(engine._device.queue.writeTexture).mockClear();
        tickAnimationCore(container.animationGroups![0]!, 16, engine);
        expect(engine._device.queue.writeTexture).not.toHaveBeenCalled();
        disposeUsd(container);
    });

    it("unlocks matrix-authored nodes before applying TRS animation", async () => {
        const fixture = usdFixture({ trsAnimation: true });
        const { engine } = usdTestEngine();
        const container = usdTestContainer(fixture);

        await materializeUsd(engine, fixture, container);
        const target = container.animationGroups![0]!.targetedAnimations[0]!.target as SceneNode;
        expect(target._localMatrixLocked).toBeUndefined();
        goToFrame(container.animationGroups![0]!, 12, engine);
        expect(target.worldMatrix[12]).toBeCloseTo(1);
        disposeUsd(container);
    });

    it("preserves independent protocol-v5 texture channels and transforms with a PBR plugin", async () => {
        const close = vi.fn();
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ width: 1, height: 1, close }))
        );
        const fixture = usdFixture({ textures: true });
        const { engine, textures } = usdTestEngine();
        const container = usdTestContainer(fixture);

        await materializeUsd(engine, fixture, container);
        const materials = getContainerMeshes(container)
            .slice(0, 2)
            .map((mesh) => mesh.material as PbrMaterialProps);
        const first = materials[0]!;
        expect(first.normalTexture).toBeUndefined();
        expect(first.alphaBlend).toBe(true);
        expect(first.occlusionStrength).toBe(1);
        expect(first.plugins).toHaveLength(1);
        const plugin = first.plugins![0] as MaterialPlugin;
        expect(plugin.getSamplers?.().map((sampler) => sampler.texture)).toEqual([
            "usdBaseTexture",
            "usdNormalTexture",
            "usdMetallicTexture",
            "usdRoughnessTexture",
            "usdOcclusionTexture",
        ]);
        expect(plugin.getCustomCode?.("fragment")?.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain("metallic=clamp");
        expect(plugin.getCustomCode?.("fragment")?.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain(".b;metallic=clamp");
        expect(plugin.getCustomCode?.("fragment")?.CUSTOM_FRAGMENT_UPDATE_DIFFUSE).toContain("usdCotangentFrame");
        const textureBindings: Array<{ texture: { uScale?: number; vScale?: number; uAng?: number; uOffset?: number; vOffset?: number } }> = [];
        plugin.bindTextures?.(textureBindings as Parameters<NonNullable<MaterialPlugin["bindTextures"]>>[0]);
        const normalTexture = textureBindings[1]!.texture;
        expect(normalTexture.uScale).toBe(2);
        expect(normalTexture.vScale).toBe(3);
        expect(normalTexture.uAng).toBeCloseTo(Math.PI / 4);
        expect(normalTexture.uOffset).toBeCloseTo(0.1 - 3 * Math.sin(Math.PI / 4));
        expect(normalTexture.vOffset).toBeCloseTo(1 - 3 * Math.cos(Math.PI / 4) - 0.2);
        const fields = plugin.getUniforms?.().ubo ?? [];
        const offsets = new Map(fields.map((field, index) => [field.name, index * 16]));
        const uniformData = new Float32Array(fields.length * 4);
        plugin.writeUbo?.(uniformData, offsets);
        expect(uniformData[offsets.get("usdBaseUVm")! / 4]).toBeCloseTo(2 * Math.cos(Math.PI / 4));
        expect(uniformData[offsets.get("usdBaseUVt")! / 4]).toBeCloseTo(0.1 - 3 * Math.sin(Math.PI / 4));
        expect(uniformData[offsets.get("usdMetallicScale")! / 4]).toBeCloseTo(0.4);
        expect(uniformData[offsets.get("usdMetallicBias")! / 4]).toBeCloseTo(0.3);
        expect(uniformData[offsets.get("usdRoughnessScale")! / 4]).toBeCloseTo(0.3);
        expect(uniformData[offsets.get("usdOcclusionScale")! / 4]).toBeCloseTo(0.2);
        expect(container._usdTextures).toHaveLength(3);
        expect(close).toHaveBeenCalledTimes(3);
        expect(materials[1]!.alphaBlend).toBe(false);

        disposeUsd(container);
        expect(textures.every((texture) => vi.mocked(texture.destroy).mock.calls.length === 1)).toBe(true);
    });

    it("keeps existing PBR plugin signatures stable when USD registers the bridge", () => {
        let extension: PbrExt | undefined;
        registerPbrPlugins((value) => {
            extension = value;
        });
        const first = createPbrMaterial({
            plugins: [{ name: "stable-before-usd", getCustomCode: () => ({ CUSTOM_FRAGMENT_BEFORE_LIGHTS: "let stableBeforeUsd=1.0;" }) }],
        });
        extension!.detect!(first);
        const firstIndex = first._pi!;
        const firstFragment = extension!.frag!({ _pi: firstIndex } as Parameters<NonNullable<PbrExt["frag"]>>[0]);

        registerPbrPlugins(() => {});
        const second = createPbrMaterial({
            plugins: [{ name: "usd-registration-probe", getCustomCode: () => ({ CUSTOM_FRAGMENT_BEFORE_LIGHTS: "let usdRegistrationProbe=1.0;" }) }],
        });
        extension!.detect!(second);

        expect(second._pi).not.toBe(firstIndex);
        expect(extension!.frag!({ _pi: firstIndex } as Parameters<NonNullable<PbrExt["frag"]>>[0])).toBe(firstFragment);
    });

    it("does not retain disposed USD extraction payloads in the PBR signature cache", async () => {
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
        );
        const cached = await (async (): Promise<{ payload: WeakRef<ArrayBuffer>; extension: PbrExt; index: number; fragment: ReturnType<NonNullable<PbrExt["frag"]>> }> => {
            const fixture = usdFixture({ textures: true });
            const { engine } = usdTestEngine();
            const container = usdTestContainer(fixture);
            await materializeUsd(engine, fixture, container);
            let extension: PbrExt | undefined;
            registerPbrPlugins((value) => {
                extension = value;
            });
            const material = getContainerMeshes(container)[0]!.material as PbrMaterialProps;
            extension!.detect!(material);
            const index = material._pi!;
            const fragment = extension!.frag!({ _pi: index } as Parameters<NonNullable<PbrExt["frag"]>>[0]);
            expect(fragment).not.toBeNull();
            const weakPayload = new WeakRef(fixture.data);
            disposeUsd(container);
            return { payload: weakPayload, extension: extension!, index, fragment };
        })();

        await collectGarbage();
        expect(cached.payload.deref()).toBeUndefined();
        expect(cached.extension.frag!({ _pi: cached.index } as Parameters<NonNullable<PbrExt["frag"]>>[0])).toBe(cached.fragment);
    });

    it("uses one thin-instance matrix slab per material subset", async () => {
        const fixture = usdFixture({ thinInstances: true });
        const { engine } = usdTestEngine();
        const container = usdTestContainer(fixture);

        await materializeUsd(engine, fixture, container);
        const meshes = getContainerMeshes(container);
        expect(meshes).toHaveLength(2);
        expect(meshes.every((mesh) => mesh.thinInstances?.count === 2)).toBe(true);
        expect(meshes[0]!.thinInstances!.matrices).toBe(meshes[1]!.thinInstances!.matrices);
        expect(meshes[0]!.thinInstances!.matrices[28]).toBe(3);
        disposeUsd(container);
    });

    it("creates subset-aware morph buffers and animates shared instance influences", async () => {
        const fixture = usdFixture({ morph: true });
        const { engine } = usdTestEngine();
        const container = usdTestContainer(fixture);

        await materializeUsd(engine, fixture, container);
        const meshes = getContainerMeshes(container);
        expect(meshes).toHaveLength(4);
        expect(meshes.every((mesh) => mesh.morphTargets?.count === 1)).toBe(true);
        expect(meshes[2]!.morphTargets).toBe(meshes[0]!.morphTargets);
        expect(meshes[3]!.morphTargets).toBe(meshes[1]!.morphTargets);
        expect(meshes[0]!.morphTargets!.targets[0]!.positions).toEqual(new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0]));
        expect(container.animationGroups![0]!.targetedAnimations.map((track) => track.path)).toEqual(["influence"]);

        goToFrame(container.animationGroups![0]!, 12, engine);
        expect(meshes[0]!.morphTargets!.weights[0]).toBeCloseTo(0.5);
        expect(meshes[1]!.morphTargets!.weights[0]).toBeCloseTo(0.5);
        expect(engine._device.queue.writeBuffer).toHaveBeenCalled();
        disposeUsd(container);
    });

    it("honors animation masks and zero-weight manager blending for USD targets", async () => {
        const fixture = usdFixture({ morph: true });
        const { engine } = usdTestEngine();
        const container = usdTestContainer(fixture);
        await materializeUsd(engine, fixture, container);
        const morph = getContainerMeshes(container)[0]!.morphTargets!;
        const group = container.animationGroups![0]!;

        group.mask = createAnimationGroupMask([], AnimationGroupMaskMode.Include);
        playAnimation(group);
        tickAnimationCore(group, 500, engine);
        expect(morph.weights[0]).toBeCloseTo(0.25);

        group.mask = undefined;
        group.currentTime = 0;
        const manager = createAnimationManager({ engine });
        addAnimationGroup(manager, group);
        enableAnimationBlending(manager);
        setAnimationWeight(group, 0);
        vi.mocked(engine._device.queue.writeBuffer).mockClear();
        updateAnimationManager(manager, 500);
        expect(morph.weights[0]).toBeCloseTo(0.25);
        expect(engine._device.queue.writeBuffer).not.toHaveBeenCalled();
        disposeUsd(container);
    });

    it("blends native USD matrices against their authored pose before skin upload", async () => {
        const fixture = usdFixture({ skin: true });
        const { engine } = usdTestEngine();
        const container = usdTestContainer(fixture);
        await materializeUsd(engine, fixture, container);
        const group = container.animationGroups![0]!;
        const target = group.targetedAnimations[0]!.target as SceneNode;
        const skin = getContainerMeshes(container)[0]!.skeleton!;
        const manager = createAnimationManager({ engine });
        addAnimationGroup(manager, group);
        enableAnimationBlending(manager);
        setAnimationWeight(group, 0.5);
        playAnimation(group);

        updateAnimationManager(manager, 500);

        expect(target.worldMatrix[12]).toBeCloseTo(0.5);
        expect(target.worldMatrix[0]).toBeCloseTo(1);
        expect(target.worldMatrix[15]).toBeCloseTo(1);
        expect(skin.boneMatrices[29]).toBeCloseTo(-0.5);
        expect(skin.boneMatrices[31]).toBeCloseTo(1);
        disposeUsd(container);
    });

    it.each([
        ["positive", 24, 1],
        ["negative", -24, -1],
    ])("preserves a %s authored animation start in direct and manager playback", async (_label, startCode, startTime) => {
        const fixture = usdFixture({ skin: true, animationStart: startCode });
        const { engine } = usdTestEngine();
        const container = usdTestContainer(fixture);
        await materializeUsd(engine, fixture, container);
        const group = container.animationGroups![0]!;
        const target = group.targetedAnimations[0]!.target as SceneNode;
        group.loopAnimation = false;
        playAnimation(group);

        expect(group.currentTime).toBe(startTime);
        expect(group.duration).toBe(1);
        tickAnimationCore(group, 500, engine);
        expect(group.currentTime).toBeCloseTo(startTime + 0.5);
        expect(target.worldMatrix[12]).toBeCloseTo(1);
        stopAnimation(group);
        expect(group.currentTime).toBe(startTime);
        goToFrame(group, startCode + 12, engine);
        expect(group.currentTime).toBeCloseTo(startTime + 0.5);
        expect(target.worldMatrix[12]).toBeCloseTo(1);

        group.currentTime = startTime;
        playAnimation(group);
        const manager = createAnimationManager({ engine });
        addAnimationGroup(manager, group);
        enableAnimationBlending(manager);
        setAnimationWeight(group, 0.5);
        updateAnimationManager(manager, 500);
        expect(group.currentTime).toBeCloseTo(startTime + 0.5);
        expect(target.worldMatrix[12]).toBeCloseTo(0.5);

        clearAnimationManager(manager);
        disposeUsd(container);
    });

    it.each([
        ["positive", 24, 1],
        ["negative", -24, -1],
    ])("evaluates a %s singleton animation at its authored time", async (_label, startCode, startTime) => {
        const fixture = usdFixture({ skin: true, animationStart: startCode, singletonAnimation: true });
        const { engine } = usdTestEngine();
        const container = usdTestContainer(fixture);
        await materializeUsd(engine, fixture, container);
        const group = container.animationGroups![0]!;
        const target = group.targetedAnimations[0]!.target as SceneNode;
        const skin = getContainerMeshes(container)[0]!.skeleton!;

        expect(group.duration).toBe(0);
        expect(group.currentTime).toBe(startTime);
        playAnimation(group);
        tickAnimationCore(group, 500, engine);
        expect(group.currentTime).toBe(startTime);
        expect(target.worldMatrix[12]).toBeCloseTo(2);

        goToFrame(group, startCode, engine);
        expect(group.currentTime).toBe(startTime);
        expect(target.worldMatrix[12]).toBeCloseTo(2);
        expect(skin.boneMatrices[29]).toBeCloseTo(1);

        const manager = createAnimationManager({ engine });
        addAnimationGroup(manager, group);
        enableAnimationBlending(manager);
        setAnimationWeight(group, 0.5);
        playAnimation(group);
        updateAnimationManager(manager, 500);
        expect(group.currentTime).toBe(startTime);
        expect(target.worldMatrix[12]).toBeCloseTo(1);
        expect(skin.boneMatrices[29]).toBeCloseTo(0);

        clearAnimationManager(manager);
        disposeUsd(container);
    });

    it.each([
        [1, 0.5, 1],
        [0.5, 0.25, 0.5],
    ])("preserves authored shear when native matrix weight is %s", async (weight, expectedShear, expectedTranslation) => {
        const fixture = usdFixture({ skin: true, shearedAnimation: true });
        const { engine } = usdTestEngine();
        const container = usdTestContainer(fixture);
        await materializeUsd(engine, fixture, container);
        const group = container.animationGroups![0]!;
        const target = group.targetedAnimations[0]!.target as SceneNode;
        const skin = getContainerMeshes(container)[0]!.skeleton!;
        const manager = createAnimationManager({ engine });
        addAnimationGroup(manager, group);
        enableAnimationBlending(manager);
        setAnimationWeight(group, weight);
        group.loopAnimation = false;
        playAnimation(group);

        updateAnimationManager(manager, 500);

        expect(target.worldMatrix[4]).toBeCloseTo(expectedShear);
        expect(target.worldMatrix[12]).toBeCloseTo(expectedTranslation);
        expect(target.worldMatrix[15]).toBe(1);
        expect(skin.boneMatrices[20]).toBeCloseTo(expectedShear);
        expect(skin.boneMatrices[31]).toBe(1);
        clearAnimationManager(manager);
        disposeUsd(container);
    });

    it("releases weighted animation scratch after clearing a long-lived manager", async () => {
        const retained = await (async (): Promise<{ manager: ReturnType<typeof createAnimationManager>; payload: WeakRef<ArrayBuffer> }> => {
            const fixture = usdFixture({ skin: true });
            const { engine } = usdTestEngine();
            const container = usdTestContainer(fixture);
            await materializeUsd(engine, fixture, container);
            const group = container.animationGroups![0]!;
            const manager = createAnimationManager({ engine });
            addAnimationGroup(manager, group);
            enableAnimationBlending(manager);
            setAnimationWeight(group, 0.5);
            playAnimation(group);
            updateAnimationManager(manager, 500);
            const payload = new WeakRef(fixture.data);
            clearAnimationManager(manager);
            disposeUsd(container);
            return { manager, payload };
        })();

        await collectGarbage();

        expect(retained.manager.animations).toHaveLength(0);
        expect(retained.payload.deref()).toBeUndefined();
    });

    it("rejects duplicate morph target IDs", async () => {
        const fixture = usdFixture({ morph: true, duplicateMorph: true });
        const { engine } = usdTestEngine();
        const container = usdTestContainer(fixture);
        await expect(materializeUsd(engine, fixture, container)).rejects.toThrow("duplicate USD morph target");
        disposeUsd(container);
    });

    it.each([
        ["scene", (fixture: ReturnType<typeof usdFixture>) => new DataView(fixture.commands).setFloat32(28, 0, true), "Invalid USD stage metadata"],
        [
            "geometry",
            (fixture: ReturnType<typeof usdFixture>) => {
                const geometry = readUsdCommands(fixture.commands).find((record) => record.op === UsdOp.Geometry)!;
                new DataView(fixture.data).setUint32(usdField(geometry, 13), 99, true);
            },
            "Invalid USD triangle indices",
        ],
    ])("rolls back an invalid %s command", async (_label, mutate, expected) => {
        const fixture = usdFixture();
        mutate(fixture);
        const { engine, buffers } = usdTestEngine();
        const container = usdTestContainer(fixture);
        await expect(materializeUsd(engine, fixture, container)).rejects.toThrow(expected);
        disposeUsd(container);
        expect(buffers.every((buffer) => vi.mocked(buffer.destroy).mock.calls.length === 1)).toBe(true);
    });
});
