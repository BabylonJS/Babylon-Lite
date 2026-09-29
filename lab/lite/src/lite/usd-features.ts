import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    getContainerMeshes,
    goToFrame,
    loadUsd,
    registerScene,
    startEngine,
} from "babylon-lite";

const ASSET_ROOT = "https://cdn.babylonjs.com/babylonUsdImporter/testAssets/";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.04, g: 0.05, b: 0.08, a: 1 };
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.8, 10, { x: 0.5, y: 1, z: 0 });
    addToScene(scene, createHemisphericLight([0.2, 1, 0.3], 1));

    const asset = new URLSearchParams(location.search).get("asset") ?? "materials";
    const fileName = asset === "morph" ? "morph-targets.usda" : asset === "bind" ? "bind-pose.usda" : "material-textures.usdz";
    const container =
        asset === "layers"
            ? await loadUsd(
                  engine,
                  new File(
                      [
                          `#usda 1.0
(
    defaultPrim = "World"
    subLayers = [@Layers/Geometry.usda@]
)
`,
                      ],
                      "Main.usda"
                  ),
                  {
                      rootFileName: "Package/Main.usda",
                      files: {
                          "Package/Layers/Geometry.usda": new TextEncoder().encode(`#usda 1.0
def Xform "World"
{
    def Cube "ComposedCube"
    {
        double size = 1
    }
}
`),
                      },
                  }
              )
            : await loadUsd(engine, `${ASSET_ROOT}${fileName}`);
    addToScene(scene, container);
    const meshes = getContainerMeshes(container);

    if (asset === "materials") {
        const materials = [...new Set(meshes.map((mesh) => mesh.material))];
        canvas.dataset.result = JSON.stringify({
            meshes: meshes.length,
            pluginMaterials: materials.filter((material) => ((material as { plugins?: readonly unknown[] }).plugins?.length ?? 0) > 0).length,
            textures: container._usdTextures.length,
        });
    } else if (asset === "morph") {
        const group = container.animationGroups?.[0];
        if (!group) {
            throw new Error("USD morph fixture did not create an animation group");
        }
        goToFrame(group, 12, engine);
        const morphs = [...new Set(meshes.flatMap((mesh) => (mesh.morphTargets ? [mesh.morphTargets] : [])))];
        canvas.dataset.result = JSON.stringify({
            targetCount: morphs[0]?.count ?? 0,
            influenceTracks: group.targetedAnimations.filter((track) => track.path === "influence").length,
            influences: Array.from(morphs[0]?.weights ?? []).sort((a, b) => a - b),
        });
    } else if (asset === "bind") {
        const mesh = meshes[0];
        canvas.dataset.result = JSON.stringify({
            parent: (mesh?.parent as { name?: string } | null)?.name,
            firstPosition: mesh?._cpuPositions?.[0],
            rootBoneY: mesh?.skeleton?.boneMatrices[13],
            childBoneY: mesh?.skeleton?.boneMatrices[29],
        });
    } else {
        canvas.dataset.result = JSON.stringify({ meshes: meshes.length, name: meshes[0]?.name, missingAssets: container.diagnostics.missingAssets });
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

void main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
