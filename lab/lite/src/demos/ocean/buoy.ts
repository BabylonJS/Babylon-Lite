import {
    addToScene,
    createPointLight,
    eulerXYZToQuatTuple,
    getContainerMeshes,
    goToFrame,
    loadGltf,
    pauseAnimation,
    playAnimation,
    type AssetContainer,
    type EngineContext,
    type Mesh,
    type PointLight,
    type SceneContext,
    type SceneNode,
} from "babylon-lite";

const BUOY_URL = "https://assets.babylonjs.com/meshes/babylonBuoy.glb";

export interface OceanBuoy {
    readonly asset: AssetContainer;
    readonly root: SceneNode;
    readonly meshes: readonly Mesh[];
    readonly light: PointLight;
    probePositions(): Float32Array;
    setSamples(samples: Float32Array): void;
    setPaused(paused: boolean): void;
    seek(timeSeconds: number, engine: EngineContext): void;
    setEnabled(enabled: boolean): void;
    setAttenuation(value: number): void;
    setSteps(value: number): void;
    seekIterations(): number;
    update(timeSeconds: number): void;
    updateSeek(timeSeconds: number): void;
}

function waterHeight(x: number, z: number, time: number): number {
    return Math.sin(x * 0.052 + z * 0.019 + time * 0.72) * 0.55 + Math.sin(x * -0.13 + z * 0.17 + time * 1.31) * 0.16 + Math.sin(x * 0.44 + z * 0.31 + time * 2.1) * 0.045;
}

export async function createOceanBuoy(engine: EngineContext, scene: SceneContext): Promise<OceanBuoy> {
    const asset = await loadGltf(engine, BUOY_URL);
    const root = asset.entities.find((entity): entity is SceneNode => !("lightType" in entity));
    if (!root) {
        throw new Error("Ocean buoy asset has no transform root.");
    }
    root.position.set(0, 0, -8);
    root.scaling.set(14, 14, 14);
    root.rotation.set(0, Math.PI / 3, 0);
    const meshes = getContainerMeshes(asset);
    for (const mesh of meshes) {
        mesh.receiveShadows = true;
    }
    addToScene(scene, asset);

    const light = createPointLight([-0.6 / 14, 6.58 / 14, 0.3 / 14], 30);
    light.diffuse = [0.96 ** 2.2, 0.7 ** 2.2, 0.15 ** 2.2];
    light.parent = root;
    addToScene(scene, light);
    let samples: Float32Array | null = null;
    let enabled = true;
    let attenuation = 0.2;
    let steps = 3;
    let currentStep = 0;
    let currentQuaternion: [number, number, number, number] = [0, 0, 0, 1];
    let stepQuaternion: [number, number, number, number] = [0, 0, 0, 1];
    const initialQuaternion: [number, number, number, number] = [root.rotationQuaternion.x, root.rotationQuaternion.y, root.rotationQuaternion.z, root.rotationQuaternion.w];
    const probePositions = new Float32Array(12);
    const localProbePoints = new Float32Array([0.7 / 14, 1 / 14, -1.5 / 14, 1, 0.7 / 14, 1 / 14, 1.5 / 14, 1, -1.5 / 14, 1 / 14, -1.5 / 14, 1]);

    const multiplyQuaternions = (a: readonly [number, number, number, number], b: readonly [number, number, number, number]): [number, number, number, number] => [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];

    const updateProbePositions = (): void => {
        const world = root.worldMatrix;
        for (let i = 0; i < 3; i++) {
            const x = localProbePoints[i * 4]!;
            const y = localProbePoints[i * 4 + 1]!;
            const z = localProbePoints[i * 4 + 2]!;
            probePositions[i * 4] = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!;
            probePositions[i * 4 + 1] = world[1]! * x + world[5]! * y + world[9]! * z + world[13]!;
            probePositions[i * 4 + 2] = world[2]! * x + world[6]! * y + world[10]! * z + world[14]!;
            probePositions[i * 4 + 3] = 1;
        }
    };

    const normalize = (x: number, y: number, z: number): [number, number, number] => {
        const length = Math.hypot(x, y, z);
        return length > 0 ? [x / length, y / length, z / length] : [0, 0, 0];
    };

    return {
        asset,
        root,
        meshes,
        light,
        probePositions(): Float32Array {
            updateProbePositions();
            return probePositions;
        },
        setSamples(value: Float32Array): void {
            samples = value;
        },
        setPaused(paused: boolean): void {
            for (const group of asset.animationGroups ?? []) {
                if (paused) {
                    pauseAnimation(group);
                } else {
                    playAnimation(group);
                }
            }
        },
        seek(timeSeconds: number, currentEngine: EngineContext): void {
            for (const group of asset.animationGroups ?? []) {
                const duration = Math.max(group.duration, 1 / 60);
                const localTime = Math.min(duration, Math.max(0, timeSeconds));
                goToFrame(group, localTime * (group.frameRate ?? 60), currentEngine);
            }
        },
        setEnabled(value: boolean): void {
            enabled = value;
        },
        setAttenuation(value: number): void {
            attenuation = value;
        },
        setSteps(value: number): void {
            steps = Math.max(1, Math.round(value));
        },
        seekIterations(): number {
            return steps * 2 + 2;
        },
        update(timeSeconds: number): void {
            if (!enabled) {
                return;
            }
            const center = samples?.[1] ?? waterHeight(root.position.x, root.position.z, timeSeconds);
            const forward = samples?.[5] ?? waterHeight(root.position.x, root.position.z + 2.5, timeSeconds);
            const right = samples?.[9] ?? waterHeight(root.position.x + 2.5, root.position.z, timeSeconds);
            const positionBlend = Math.max(0.001, attenuation);
            const rotationBlend = Math.max(0.001, attenuation / steps);
            root.position.y += (center - root.position.y) * positionBlend;
            root.rotation.x += (Math.atan2(forward - center, 2.5) - root.rotation.x) * rotationBlend;
            root.rotation.z += (-Math.atan2(right - center, 2.5) - root.rotation.z) * rotationBlend;
        },
        updateSeek(timeSeconds: number): void {
            if (!enabled) {
                return;
            }
            const center = samples?.[1] ?? waterHeight(root.position.x, root.position.z, timeSeconds);
            const forward = samples?.[5] ?? waterHeight(root.position.x, root.position.z + 2.5, timeSeconds);
            const right = samples?.[9] ?? waterHeight(root.position.x + 2.5, root.position.z, timeSeconds);
            root.position.y = center;
            if (currentStep < steps) {
                currentStep++;
                currentQuaternion = multiplyQuaternions(currentQuaternion, stepQuaternion);
                const rotation = multiplyQuaternions(initialQuaternion, currentQuaternion);
                root.rotationQuaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
                return;
            }

            const cx = probePositions[0]!;
            const cy = probePositions[1]!;
            const cz = probePositions[2]!;
            const [forwardUx, forwardUy, forwardUz] = normalize(probePositions[4]! - cx, probePositions[5]! - cy, probePositions[6]! - cz);
            const [rightUx, rightUy, rightUz] = normalize(probePositions[8]! - cx, probePositions[9]! - cy, probePositions[10]! - cz);
            const [forwardX, forwardY, forwardZ] = normalize(probePositions[4]! - cx, forward - center, probePositions[6]! - cz);
            let [rightX, rightY, rightZ] = normalize(probePositions[8]! - cx, right - center, probePositions[10]! - cz);
            const normalX = rightY * forwardZ - rightZ * forwardY;
            const normalY = rightZ * forwardX - rightX * forwardZ;
            const normalZ = rightX * forwardY - rightY * forwardX;
            [rightX, rightY, rightZ] = normalize(forwardY * normalZ - forwardZ * normalY, forwardZ * normalX - forwardX * normalZ, forwardX * normalY - forwardY * normalX);
            let angleX = Math.acos(Math.min(1, Math.max(0, forwardUx * forwardX + forwardUy * forwardY + forwardUz * forwardZ))) * attenuation;
            let angleZ = Math.acos(Math.min(1, Math.max(0, rightUx * rightX + rightUy * rightY + rightUz * rightZ))) * attenuation;
            if (forwardY > forwardUy) {
                angleX = -angleX;
            }
            if (rightY > rightUy) {
                angleZ = -angleZ;
            }
            stepQuaternion = eulerXYZToQuatTuple(angleX / steps, 0, angleZ / steps);
            currentStep = 0;
        },
    };
}
