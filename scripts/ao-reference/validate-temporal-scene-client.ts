import { createEngine, renderFrame, resizeEngine } from "../../packages/babylon-lite/src/engine/engine.js";
import { createSceneContext, addToScene, registerScene, disposeScene } from "../../packages/babylon-lite/src/scene/scene-core.js";
import { setMeshVisible } from "../../packages/babylon-lite/src/scene/scene.js";
import { createFreeCamera } from "../../packages/babylon-lite/src/camera/free-camera.js";
import { createPlane } from "../../packages/babylon-lite/src/mesh/mesh-factories.js";
import { createPbrMaterial } from "../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { createGeometryRendererTask } from "../../packages/babylon-lite/src/frame-graph/geometry-renderer-task.js";
import { enableGeometryVelocity } from "../../packages/babylon-lite/src/frame-graph/enable-geometry-velocity.js";
import { GeometryTextureType } from "../../packages/babylon-lite/src/frame-graph/geometry-types.js";
import { addTask } from "../../packages/babylon-lite/src/frame-graph/frame-graph-actions.js";
import { createCopyToTextureTask } from "../../packages/babylon-lite/src/frame-graph/copy-to-texture-task.js";
import { createSsaoTask } from "../../packages/babylon-lite/src/post-process/ssao.js";
import { enableSsaoTemporal, resetSsaoTemporal } from "../../packages/babylon-lite/src/post-process/ssao-temporal.js";
import { getProjectionMatrix } from "../../packages/babylon-lite/src/camera/camera.js";
import { enableSsaoHalfResolution } from "../../packages/babylon-lite/src/post-process/ssao-half-resolution.js";
import type { DiligentTemporalGpu } from "../../packages/babylon-lite/src/post-process/ssao-diligent-gpu.js";

/** Actual PBR geometry motion, not only injected velocity textures. */
export async function validateTemporalScene(half = false): Promise<void> {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:64px;height:64px";
    document.body.append(canvas);
    const engine = await createEngine(canvas, { msaaSamples: 1, maxDevicePixelRatio: 1 });
    const device = engine._device,
        errors: string[] = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    try {
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        camera.nearPlane = 0.1;
        camera.farPlane = 20;
        scene.camera = camera;
        const plane = createPlane(engine, { size: 2 });
        plane.position.z = 3;
        plane.material = createPbrMaterial();
        addToScene(scene, plane);
        const geometry = createGeometryRendererTask(
            {
                samples: 1,
                textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }, { type: GeometryTextureType.LINEAR_VELOCITY, format: "rgba32float" }],
            },
            engine,
            scene
        );
        enableGeometryVelocity(geometry, { previousDepth: true });
        const ao = createSsaoTask({ depthTexture: geometry.geometryDepthTexture, normalTexture: geometry.geometryViewNormalTexture!, camera }, engine, scene);
        const settings = enableSsaoTemporal(ao, { velocityTexture: geometry.geometryLinearVelocityTexture!, velocityHasPreviousDepth: true });
        const resolution = half ? enableSsaoHalfResolution(ao) : null;
        let publications = 0;
        ao._onOutputChanged = () => publications++;
        const assertPublications = (expected: number): void => {
            if (publications !== expected) {
                throw new Error(`Unexpected AO output publication count: ${publications} versus ${expected}`);
            }
        };
        addTask(scene, geometry);
        addTask(scene, ao);
        addTask(scene, createCopyToTextureTask({ name: "ao-normal-source-consumer", sourceTexture: ao.outputTexture, targetTexture: engine.scRT }, engine, scene));
        await registerScene(scene);
        const motion = async (): Promise<[number, number, number]> => {
            renderFrame(engine, 16);
            const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            try {
                const encoder = device.createCommandEncoder();
                encoder.copyTextureToBuffer({ texture: geometry.geometryLinearVelocityTexture!._colorTexture!, origin: [32, 32] }, { buffer, bytesPerRow: 256 }, [1, 1]);
                device.queue.submit([encoder.finish()]);
                await buffer.mapAsync(GPUMapMode.READ);
                const data = new DataView(buffer.getMappedRange());
                return [data.getFloat32(0, true), data.getFloat32(4, true), data.getFloat32(8, true)];
            } finally {
                buffer.destroy();
            }
        };
        const initial = await motion();
        if (initial[0] !== 0 || initial[1] !== 0 || Math.abs(initial[2] - 3) > 1e-5) {
            throw new Error("Initial PBR velocity/depth was not current-surface neutral.");
        }
        const output = ao.outputTexture._colorTexture;
        plane.position.x = 0.3;
        const translated = await motion();
        const projection = getProjectionMatrix(camera, 1);
        const expected = (-0.3 * projection[0]!) / 6;
        if (Math.abs(translated[0] - expected) > 0.00015 || Math.abs(translated[1]) > 1e-5) {
            throw new Error(`PBR object motion lost its previous transform: ${translated[0]} versus ${expected}`);
        }
        const stopped = await motion();
        if (Math.abs(stopped[0]) > 1e-5 || Math.abs(stopped[1]) > 1e-5) {
            throw new Error("PBR velocity repeated stale motion on the following frame.");
        }
        plane.position.z = 3.4;
        const approaching = await motion();
        if (Math.abs(approaching[2] - 3) > 1e-5) {
            throw new Error("PBR depth-changing motion did not supply previous surface depth.");
        }
        const stoppedDepth = await motion();
        if (Math.abs(stoppedDepth[2] - 3.4) > 1e-5) {
            throw new Error("PBR previous-depth payload repeated stale object depth.");
        }
        geometry.excludeFromVelocity(plane);
        plane.position.x = 0.45;
        const excluded = await motion();
        if (excluded[0] !== 0 || excluded[1] !== 0 || Math.abs(excluded[2] - 3.4) > 1e-5) {
            throw new Error("PBR geometry velocity exclusion was ignored.");
        }
        geometry.includeInVelocity(plane);
        for (let i = 0; i < 32; i++) {
            await motion();
        }
        if (ao.outputTexture._colorTexture !== output) {
            throw new Error("Temporal frames reallocated the material-sampled AO output.");
        }
        assertPublications(1);
        if (resolution) {
            resolution.enabled = false;
            await motion();
            resolution.enabled = true;
            await motion();
            assertPublications(1);
        }
        settings.enabled = false;
        await motion();
        settings.enabled = true;
        resetSsaoTemporal(settings);
        await motion();
        ao.enabled = false;
        await motion();
        ao.enabled = true;
        await motion();
        canvas.style.width = "96px";
        resizeEngine(engine);
        await motion();
        if (ao.outputTexture._width !== 96) {
            throw new Error("Temporal AO did not follow a real surface resize.");
        }
        assertPublications(2);
        plane.scaling.x = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
            let rejected = false;
            try {
                renderFrame(engine, 16);
            } catch (error) {
                if (!(error instanceof Error) || !error.message.includes("singular world")) {
                    throw error;
                }
                rejected = true;
            }
            if (!rejected) {
                throw new Error("Singular PBR world transforms did not fail consistently.");
            }
        }
        setMeshVisible(plane, false);
        await motion();
        plane.scaling.x = 1;
        setMeshVisible(plane, true);
        await motion();
        let temporalOwner: DiligentTemporalGpu | null = null;
        settings._prepareGpu = (owner) => {
            temporalOwner = owner;
        };
        const currentTemporal = (): DiligentTemporalGpu => {
            if (!temporalOwner) {
                throw new Error("Normal-source check did not prepare its temporal owner.");
            }
            return temporalOwner;
        };
        const historyCount = async (): Promise<number> => {
            const owner = currentTemporal();
            const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            try {
                const encoder = device.createCommandEncoder();
                encoder.copyTextureToBuffer(
                    { texture: owner.counts[owner.index]!, origin: [Math.floor(ao.outputTexture._width / 2), Math.floor(ao.outputTexture._height / 2)] },
                    { buffer, bytesPerRow: 256 },
                    [1, 1]
                );
                device.queue.submit([encoder.finish()]);
                await buffer.mapAsync(GPUMapMode.READ);
                const value = new DataView(buffer.getMappedRange()).getUint16(0, true);
                return (1 + (value & 1023) / 1024) * 2 ** (((value >> 10) & 31) - 15);
            } finally {
                buffer.destroy();
            }
        };
        canvas.style.width = "339px";
        canvas.style.height = "225px";
        resizeEngine(engine);
        await motion();
        assertPublications(3);
        if (resolution && !resolution.active) {
            throw new Error("Normal-source check did not exercise active half-resolution estimation.");
        }
        const managed = ao.outputTexture;
        const visibilityOutput = ao.outputTexture._colorTexture;
        for (const normal of [null, geometry.geometryViewNormalTexture!]) {
            const previousGpu = ao._gpu;
            const previousOwner = currentTemporal();
            ao.normalTexture = normal;
            await motion();
            if (
                ao._gpu !== previousGpu ||
                ao.outputTexture._colorTexture !== visibilityOutput ||
                currentTemporal() === previousOwner ||
                ao._gpu!.providedNormals !== (normal !== null)
            ) {
                throw new Error("Normal-source switching replaced the stable output owner or reused the wrong temporal shader variant.");
            }
            if (currentTemporal().data[48] !== 1 || (await historyCount()) !== 1) {
                throw new Error("Normal-source switching retained incompatible history.");
            }
            const gpu = ao._gpu;
            const owner = currentTemporal();
            const visibility = ao.outputTexture._colorTexture;
            await motion();
            await motion();
            if (ao._gpu !== gpu || currentTemporal() !== owner || ao.outputTexture._colorTexture !== visibility || (await historyCount()) <= 1) {
                throw new Error("Unchanged normal sources reallocated owners or failed to accumulate.");
            }
        }
        assertPublications(3);
        if (resolution) {
            for (const temporalEnabled of [true, false]) {
                settings.enabled = temporalEnabled;
                for (const halfEnabled of [false, true, false, true]) {
                    const gpu = ao._gpu,
                        owner = currentTemporal();
                    resolution.enabled = halfEnabled;
                    await motion();
                    if (ao._gpu !== gpu || currentTemporal() !== owner || ao.outputTexture._colorTexture !== visibilityOutput) {
                        throw new Error("Working-resolution switching reallocated the output or temporal owner.");
                    }
                    if ((ao._gpu!.working === null) !== halfEnabled || (ao._gpu!.resolveGroup === null) !== halfEnabled) {
                        throw new Error("Working textures/resolve bindings did not follow active Full/Half estimation.");
                    }
                    if (temporalEnabled && currentTemporal().data[48] !== 1) throw new Error("Working-resolution change did not reset temporal accumulation.");
                    await motion();
                }
            }
            settings.enabled = true;
            await motion();
        }
        const suppliedGpu = ao._gpu;
        const suppliedOwner = currentTemporal();
        const suppliedOutput = ao.outputTexture._colorTexture;
        const source = geometry.geometryViewNormalTexture!;
        ao.normalTexture = { ...source, _colorView: source._colorTexture!.createView() };
        await motion();
        if (ao._gpu !== suppliedGpu || currentTemporal() !== suppliedOwner || ao.outputTexture._colorTexture !== suppliedOutput || ao.outputTexture !== managed) {
            throw new Error("Replacing a supplied normal view reallocated compatible owners or the managed output.");
        }
        if (currentTemporal().data[48] !== 1 || (await historyCount()) !== 1) {
            throw new Error("Replacing a supplied normal view did not reset temporal history.");
        }
        assertPublications(3);
        await device.queue.onSubmittedWorkDone();
        if (errors.length) {
            throw new Error(errors.join("\n"));
        }
    } finally {
        disposeScene(scene);
        canvas.remove();
        device.destroy();
    }
}
