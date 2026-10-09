import {
    addToScene,
    createDefaultCamera,
    createEngine,
    createMeshFromData,
    createPbrMaterial,
    createSceneContext,
    createShaderMaterial,
    createStandardMaterial,
    disposeEngine,
    getMeshGeometry,
    registerScene,
    renderFrame,
    setMeshDrawRange,
    updateMeshGeometry,
    updateMeshGeometryCapacity,
    wgsl,
} from "babylon-lite";
import type { MeshDrawRange } from "babylon-lite";

export interface MeshDrawRangeTest {
    select(kind: "card" | "points", range: MeshDrawRange): void;
    restoreCard(capacity: boolean): void;
    render(): void;
    geometry(): ReturnType<typeof getMeshGeometry>;
    dispose(): void;
}

declare global {
    interface Window {
        meshDrawRangeTest: MeshDrawRangeTest;
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    createDefaultCamera(scene);
    const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0, 0, 0, 0]);
    const cardPositions = positions.subarray(0, 12);
    const cardNormals = new Float32Array(12);
    const cardIndices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const card = createMeshFromData(engine, "card", cardPositions, cardNormals, cardIndices);
    const points = createMeshFromData(engine, "points", positions, new Float32Array(15), new Uint32Array([0, 1, 2, 3, 4]));
    const material = new URLSearchParams(location.search).get("material");
    for (const mesh of [card, points]) {
        if (mesh === card && material === "standard") {
            mesh.material = createStandardMaterial();
        } else if (mesh === card && material === "pbr") {
            mesh.material = createPbrMaterial();
        } else {
            mesh.material = createShaderMaterial({
                attributes: ["position"],
                vertexSource: wgsl`@vertex fn mainVertex(input:VertexInput)->@builtin(position) vec4<f32>{return vec4<f32>(input.position.xy,0.5,1.0);}`,
                fragmentSource: wgsl`@fragment fn mainFragment()->@location(0) vec4<f32>{return vec4<f32>(0.0,1.0,0.0,1.0);}`,
                topology: mesh === points ? "point-list" : "triangle-list",
                backFaceCulling: false,
            });
        }
        addToScene(scene, mesh);
    }
    points.visible = false;
    await registerScene(scene);
    let active = card;
    window.meshDrawRangeTest = {
        select(kind, range): void {
            active = kind === "card" ? card : points;
            card.visible = active === card;
            points.visible = active === points;
            setMeshDrawRange(engine, active, range);
        },
        restoreCard(capacity): void {
            active = card;
            card.visible = true;
            points.visible = false;
            if (capacity) {
                updateMeshGeometryCapacity(engine, card, cardPositions, cardNormals, cardIndices);
            } else {
                updateMeshGeometry(engine, card, cardPositions, cardNormals, cardIndices);
            }
        },
        render(): void {
            renderFrame(engine, 0);
        },
        geometry(): ReturnType<typeof getMeshGeometry> {
            return getMeshGeometry(active);
        },
        dispose(): void {
            disposeEngine(engine);
        },
    };
    renderFrame(engine, 0);
    canvas.dataset.ready = "true";
}

void main().catch((error: unknown) => {
    console.error(error);
    document.getElementById("renderCanvas")!.dataset.error = error instanceof Error ? error.message : String(error);
});
