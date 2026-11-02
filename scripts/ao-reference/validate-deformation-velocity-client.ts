import { createEngine, renderFrame } from "../../packages/babylon-lite/src/engine/engine.js";
import { addToScene, createSceneContext, disposeScene, registerScene } from "../../packages/babylon-lite/src/scene/scene-core.js";
import { setMeshVisible } from "../../packages/babylon-lite/src/scene/scene.js";
import { createFreeCamera } from "../../packages/babylon-lite/src/camera/free-camera.js";
import { getViewProjectionMatrix } from "../../packages/babylon-lite/src/camera/camera.js";
import { createMeshFromData } from "../../packages/babylon-lite/src/mesh/mesh-factories.js";
import { createPbrMaterial } from "../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { createStandardMaterial } from "../../packages/babylon-lite/src/material/standard/create-standard-material.js";
import { enableStandardSkeleton } from "../../packages/babylon-lite/src/material/standard/enable-standard-mesh-features.js";
import { createSkeleton } from "../../packages/babylon-lite/src/skeleton/create-skeleton.js";
import { updateSkeletonBoneMatrices } from "../../packages/babylon-lite/src/skeleton/update-skeleton-bone-matrices.js";
import { createMorphTargets, setMorphTargetWeights } from "../../packages/babylon-lite/src/morph/create-morph-targets.js";
import { createGeometryRendererTask } from "../../packages/babylon-lite/src/frame-graph/geometry-renderer-task.js";
import { enableGeometryVelocity } from "../../packages/babylon-lite/src/frame-graph/enable-geometry-velocity.js";
import { GeometryTextureType } from "../../packages/babylon-lite/src/frame-graph/geometry-types.js";
import { addTask } from "../../packages/babylon-lite/src/frame-graph/frame-graph-actions.js";
import { invertMat4 } from "../../packages/babylon-lite/src/math/invert-mat4.js";
import type { Mat4 } from "../../packages/babylon-lite/src/math/types.js";
import { createSsaoTask } from "../../packages/babylon-lite/src/post-process/ssao.js";
import { enableSsaoTemporal } from "../../packages/babylon-lite/src/post-process/ssao-temporal.js";

type Matrix = Float64Array;
function transform(m: ArrayLike<number>, p: readonly number[]) {
    return [0, 1, 2, 3].map((row) => m[row]! * p[0]! + m[row + 4]! * p[1]! + m[row + 8]! * p[2]! + m[row + 12]! * p[3]!);
}
function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Matrix {
    const result = new Float64Array(16);
    for (let column = 0; column < 4; column++) {
        const values = transform(a, [b[column * 4]!, b[column * 4 + 1]!, b[column * 4 + 2]!, b[column * 4 + 3]!]);
        result.set(values, column * 4);
    }
    return result;
}
function identity(): Matrix {
    const m = new Float64Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

/** Analytic previous material-point reconstruction, checked against actual MRT output. */
export async function validateDeformationVelocity() {
    const results = [];
    enableStandardSkeleton();
    for (const family of ["pbr", "standard"] as const) {
        for (const deformation of ["skin4", "skin8", "morph", "combined"] as const) {
            const canvas = document.createElement("canvas");
            canvas.style.cssText = "width:192px;height:160px";
            document.body.append(canvas);
            const engine = await createEngine(canvas, { msaaSamples: 1, maxDevicePixelRatio: 1 });
            const device = engine._device,
                scene = createSceneContext(engine, { defaultRenderTask: false }),
                errors: string[] = [];
            device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
            try {
                const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
                camera.nearPlane = 0.1;
                camera.farPlane = 20;
                scene.camera = camera;
                const positions = new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]);
                const mesh = createMeshFromData(
                    engine,
                    "deformation-velocity",
                    positions,
                    new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]),
                    new Uint32Array([0, 2, 1, 1, 2, 3]),
                    new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])
                );
                if (family === "pbr") {
                    mesh.material = createPbrMaterial({ doubleSided: true });
                } else {
                    const material = createStandardMaterial();
                    material.backFaceCulling = false;
                    mesh.material = material;
                }
                mesh.position.z = 3;
                const skinned = deformation !== "morph",
                    morphed = deformation === "morph" || deformation === "combined",
                    eight = deformation === "skin8";
                const boneCount = eight ? 8 : 4,
                    boneMatrices = new Float32Array(boneCount * 16);
                const boneWeights = new Float32Array(16),
                    joints = new Uint16Array(16),
                    extraWeights = new Float32Array(16),
                    extraJoints = new Uint16Array(16);
                for (let v = 0; v < 4; v++) {
                    for (let i = 0; i < 4; i++) {
                        joints[v * 4 + i] = i;
                        boneWeights[v * 4 + i] = eight ? 0.125 : 0.25;
                        extraJoints[v * 4 + i] = i + 4;
                        extraWeights[v * 4 + i] = 0.125;
                    }
                }
                for (let i = 0; i < boneCount; i++) {
                    boneMatrices.set(identity(), i * 16);
                }
                if (skinned) {
                    mesh.skeleton = createSkeleton(engine, joints, boneWeights, boneCount, boneMatrices, eight ? extraJoints : undefined, eight ? extraWeights : undefined);
                }
                const targets = Array.from({ length: 5 }, (_, i) => {
                    const delta = new Float32Array(12);
                    for (let v = 0; v < 4; v++) {
                        delta[v * 3] = 0.02 * (i + 1);
                        delta[v * 3 + 2] = 0.015 * (i + 1);
                    }
                    return { positions: delta, normals: null };
                });
                if (morphed) {
                    mesh.morphTargets = createMorphTargets(engine, targets, 4, [0, 0, 0, 0, 0]);
                }
                addToScene(scene, mesh);
                const geometry = createGeometryRendererTask(
                    {
                        samples: 1,
                        textureDescriptions: [
                            { type: GeometryTextureType.WORLD_POSITION, format: "rgba32float" },
                            { type: GeometryTextureType.LINEAR_VELOCITY, format: "rgba32float" },
                        ],
                    },
                    engine,
                    scene
                );
                enableGeometryVelocity(geometry, { previousDepth: true });
                const defaultVelocity = createGeometryRendererTask(
                    {
                        samples: 1,
                        textureDescriptions: [{ type: GeometryTextureType.LINEAR_VELOCITY, format: "rgba32float" }],
                    },
                    engine,
                    scene
                );
                enableGeometryVelocity(defaultVelocity);
                const ao = createSsaoTask({ depthTexture: geometry.geometryDepthTexture, camera }, engine, scene);
                enableSsaoTemporal(ao, { velocityTexture: geometry.geometryLinearVelocityTexture!, velocityHasPreviousDepth: true });
                addTask(scene, geometry);
                addTask(scene, defaultVelocity);
                addTask(scene, ao);
                await registerScene(scene);
                let previousWorld = identity(),
                    previousSkin = identity(),
                    previousMorph = [0, 0, 0],
                    previousVP = identity();
                let maxVelocityError = 0,
                    maxDepthError = 0,
                    checked = 0;
                const read = async (texture: GPUTexture) => {
                    const pitch = 192 * 16;
                    const buffer = device.createBuffer({ size: pitch * 160, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                    try {
                        const encoder = device.createCommandEncoder();
                        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: pitch }, [192, 160]);
                        device.queue.submit([encoder.finish()]);
                        await buffer.mapAsync(GPUMapMode.READ);
                        return new Float32Array(buffer.getMappedRange().slice(0));
                    } finally {
                        buffer.destroy();
                    }
                };
                const frames = [
                    { pose: 0.2, world: 0, camera: 0, neutral: true },
                    { pose: 0.7, world: 0, camera: 0, neutral: false },
                    { pose: 0.7, world: 0, camera: 0, neutral: false },
                    { pose: -0.3, world: 0.12, camera: 0.06, neutral: false },
                    { pose: 0.4, world: 0.14, camera: 0.08, neutral: true, excluded: true },
                    { pose: 0.8, world: 0.16, camera: 0.1, neutral: true },
                    { pose: 0.1, world: 0.18, camera: 0.12, neutral: false },
                    { pose: 0.6, world: 0.2, camera: 0.14, neutral: true, hidden: true },
                    { pose: -0.2, world: 0.22, camera: 0.16, neutral: true },
                    { pose: -0.2, world: 0.22, camera: 0.16, neutral: false },
                ];
                for (const [frame, settings] of frames.entries()) {
                    const skin = identity(),
                        morph = [0, 0, 0];
                    if (skinned) {
                        skin.fill(0);
                        for (let i = 0; i < boneCount; i++) {
                            const bone = identity(),
                                angle = settings.pose * (0.2 + i * 0.015),
                                c = Math.cos(angle),
                                s = Math.sin(angle);
                            bone[0] = c;
                            bone[1] = s;
                            bone[4] = -s;
                            bone[5] = c;
                            bone[12] = settings.pose * (i + 1) * 0.02;
                            bone[14] = settings.pose * (i + 1) * 0.015;
                            boneMatrices.set(bone, i * 16);
                            for (let j = 0; j < 16; j++) {
                                skin[j] = skin[j]! + boneMatrices[i * 16 + j]! / boneCount;
                            }
                        }
                        updateSkeletonBoneMatrices(engine, mesh.skeleton!, boneMatrices);
                    }
                    if (morphed) {
                        const weights = [settings.pose, settings.pose * 0.5, -settings.pose * 0.25, settings.pose * 0.75, settings.pose * 0.1];
                        setMorphTargetWeights(engine, mesh.morphTargets!, weights);
                        for (let i = 0; i < 5; i++) {
                            morph[0] = morph[0]! + Math.fround(weights[i]!) * targets[i]!.positions[0]!;
                            morph[2] = morph[2]! + Math.fround(weights[i]!) * targets[i]!.positions[2]!;
                        }
                    }
                    mesh.position.x = settings.world;
                    setMeshVisible(mesh, !settings.hidden);
                    camera.position.x = settings.camera;
                    camera.position.z = settings.camera * 0.5;
                    if (settings.excluded) {
                        geometry.excludeFromVelocity(mesh);
                        defaultVelocity.excludeFromVelocity(mesh);
                    } else {
                        geometry.includeInVelocity(mesh);
                        defaultVelocity.includeInVelocity(mesh);
                    }
                    renderFrame(engine, 16);
                    const world = new Float64Array(mesh.worldMatrix),
                        vp = new Float64Array(getViewProjectionMatrix(camera, 192 / 160));
                    if (!settings.hidden) {
                        const current = multiply(world, skin),
                            inverse = invertMat4(current as unknown as Mat4);
                        if (!inverse) {
                            throw new Error("Analytic velocity fixture is singular.");
                        }
                        const positionsGpu = await read(geometry.geometryWorldPositionTexture!._colorTexture!),
                            velocities = await read(geometry.geometryLinearVelocityTexture!._colorTexture!);
                        const ordinary = await read(defaultVelocity.geometryLinearVelocityTexture!._colorTexture!);
                        for (const y of [75, 80, 85]) {
                            for (const x of [91, 96, 101]) {
                                const offset = (y * 192 + x) * 4;
                                if (
                                    ordinary[offset + 2] !== 0 ||
                                    Math.abs(ordinary[offset]! - velocities[offset]!) > 0.000002 ||
                                    Math.abs(ordinary[offset + 1]! - velocities[offset + 1]!) > 0.000002
                                ) {
                                    throw new Error("Geometry tasks shared deformation history or changed the default zero-Z velocity contract.");
                                }
                                if (positionsGpu[offset + 3] !== 1) {
                                    throw new Error(`Deformation fixture missed receiver ${family}/${deformation}/${frame}.`);
                                }
                                const point = [positionsGpu[offset]!, positionsGpu[offset + 1]!, positionsGpu[offset + 2]!, 1];
                                const base = transform(inverse, point);
                                base[0] = base[0]! - morph[0]!;
                                base[2] = base[2]! - morph[2]!;
                                const old = transform(multiply(previousWorld, previousSkin), [base[0] + previousMorph[0]!, base[1]!, base[2] + previousMorph[2]!, 1]);
                                const currentClip = transform(vp, point),
                                    oldClip = settings.neutral ? currentClip : transform(previousVP, old);
                                const expectedX = (oldClip[0]! / oldClip[3]! - currentClip[0]! / currentClip[3]!) * 0.5;
                                const expectedY = (oldClip[1]! / oldClip[3]! - currentClip[1]! / currentClip[3]!) * 0.5;
                                const error = Math.max(Math.abs(velocities[offset]! - expectedX), Math.abs(velocities[offset + 1]! - expectedY));
                                const depthError = Math.abs(velocities[offset + 2]! - oldClip[3]!);
                                maxVelocityError = Math.max(maxVelocityError, error);
                                maxDepthError = Math.max(maxDepthError, depthError);
                                checked++;
                                if (error > 0.00002 || depthError > 0.00002) {
                                    throw new Error(`Incorrect deformation velocity ${family}/${deformation}/frame${frame}: XY error ${error}, depth error ${depthError}.`);
                                }
                            }
                        }
                    }
                    previousWorld = world;
                    previousSkin = skin;
                    previousMorph = morph;
                    previousVP = vp;
                }
                await device.queue.onSubmittedWorkDone();
                if (errors.length) {
                    throw new Error(errors.join("\n"));
                }
                results.push({ family, deformation, checked, maxVelocityError, maxDepthError, frames: frames.length });
            } finally {
                disposeScene(scene);
                device.destroy();
                canvas.remove();
            }
        }
    }
    return results;
}
