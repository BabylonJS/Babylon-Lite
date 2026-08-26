// SPEC-VOLATILE — KHR_interactivity release candidate. This feature is the only
// loader-side entrypoint; all spec-dependent parsing lives under
// flow-graph/gltf/. Mirrored against Babylon.js commit
// bd3837eed0890e590fdd6aeb6cc4d605e4eb8ac7.
//
// gltf-feature-interactivity: a per-asset glTF feature. At applyAsset time the
// node hierarchy (`ctx._nodeMap`) is built but animation groups are NOT yet
// available, so this feature only does the spec-volatile, node-dependent work —
// parse each graph and pre-resolve its JSON pointers to TRS accessors — and
// hands the result to the AssetContainer. Binding animations + scene capabilities
// and driving the runtime happens later, in addToScene → runFlowGraphs.

import type { GltfFeature, GltfLoadCtx } from "./gltf-feature.js";
import type { Mesh } from "../mesh/mesh.js";
import type { TransformNode } from "../scene/transform-node.js";
import type { AssetContainer } from "../asset-container.js";
import type { FgAccessor, LoadedFlowGraph } from "../flow-graph/context.js";
import type { PointerMaterial } from "./animation-pointer.js";
import { parseInteractivityGraph, type GltfInteractivityGraph } from "../flow-graph/gltf/interactivity-parser.js";
import { resolvePointerAccessor, type PointerResolveContext } from "../flow-graph/gltf/path-converter.js";
import { detachFlowGraph, runFlowGraphs } from "../flow-graph/scene-flow-graph.js";
import { _registerAssetContainerSceneCleanup } from "./gltf-scene-cleanup.js";
import { parseFlowGraphEditorJson } from "../flow-graph/editor-serialization.js";

interface IKHRInteractivity {
    graphs?: GltfInteractivityGraph[];
}

interface InteractivityMesh extends Mesh {
    /** glTF node owning this primitive, used by the Flow Graph selection bridge. */
    _gltfNodeIndex?: number;
    /** Opaque identity of the asset that owns this primitive. */
    _flowGraphAssetScope?: object;
}

/** Build a glTF-material-index → runtime-material map by walking the node→mesh→
 *  primitive hierarchy in the same order the loader instantiates GPU meshes
 *  (mirrors KHR_animation_pointer's `materialMap`). Lets a `pointer/{get,set}` on
 *  a material's UV transform reach the live PBR material. The same walk records
 *  each primitive's source node for `event/onSelect`. */
function buildMaterialMap(
    json: { nodes?: { mesh?: number }[]; meshes?: { primitives?: { material?: number }[] }[] },
    meshes: readonly Mesh[],
    assetScope: object
): (PointerMaterial | undefined)[] {
    const map: (PointerMaterial | undefined)[] = [];
    const nodes = json.nodes ?? [];
    let gpuIdx = 0;
    for (let ni = 0; ni < nodes.length; ni++) {
        const meshRef = nodes[ni]?.mesh;
        if (meshRef === undefined) {
            continue;
        }
        const prims = json.meshes?.[meshRef]?.primitives ?? [];
        for (let p = 0; p < prims.length; p++) {
            const matIdx = prims[p]?.material;
            const mesh = meshes[gpuIdx++];
            if (mesh) {
                (mesh as InteractivityMesh)._gltfNodeIndex = ni;
                (mesh as InteractivityMesh)._flowGraphAssetScope = assetScope;
            }
            if (matIdx !== undefined && mesh) {
                map[matIdx] = mesh.material as unknown as PointerMaterial;
            }
        }
    }
    return map;
}

const feature: GltfFeature = {
    id: "KHR_interactivity",
    async applyAsset(_meshes: Mesh[], _root: TransformNode, ctx: GltfLoadCtx): Promise<Partial<AssetContainer>> {
        const ext = ctx._json.extensions?.KHR_interactivity as IKHRInteractivity | undefined;
        const graphs = ext?.graphs ?? [];
        const nodeMap = ctx._nodeMap ?? [];
        const assetScope = {};
        const materials = buildMaterialMap(ctx._json, _meshes, assetScope);
        const resolveCtx: PointerResolveContext = { nodeMap, materials, json: ctx._json };

        const flowGraphs: LoadedFlowGraph[] = [];
        for (let graphIndex = 0; graphIndex < graphs.length; graphIndex++) {
            try {
                const { graph, pointers } = await parseInteractivityGraph(graphs[graphIndex]!);
                const accessors: Record<string, FgAccessor> = {};
                for (const pointer of pointers) {
                    const accessor = resolvePointerAccessor(pointer, resolveCtx);
                    if (accessor) {
                        accessors[pointer] = accessor;
                    }
                }
                flowGraphs.push({
                    graph,
                    rightHanded: true,
                    accessors,
                    resolveAccessor: (pointer, scene, animations) => resolvePointerAccessor(pointer, { ...resolveCtx, scene, animations }),
                    _assetScope: assetScope,
                });
            } catch (error) {
                console.warn(`KHR_interactivity: rejected graph ${graphIndex}:`, error);
            }
        }

        const editorJson = (ctx._json.extensions?.BABYLON_flow_graph as { flowGraph?: unknown } | undefined)?.flowGraph;
        if (editorJson) {
            try {
                const parsed = await parseFlowGraphEditorJson(editorJson, {
                    resolveReference(value) {
                        const id = value.id ?? value.name;
                        return nodeMap.find((node) => node && (((node as TransformNode & { id?: string }).id ?? node.name) === id || node.name === id));
                    },
                });
                parsed.graphs.forEach((graph, index) => flowGraphs.push({ graph, rightHanded: parsed.rightHanded[index], accessors: {}, _assetScope: assetScope }));
            } catch (error) {
                console.warn("BABYLON_flow_graph: rejected editor graph JSON:", error);
            }
        }

        if (flowGraphs.length === 0) {
            return {};
        }
        return {
            flowGraphs,
            _sceneSetup(scene, container) {
                let removed = false;
                let active: Awaited<ReturnType<typeof runFlowGraphs>> = [];
                const runtimes = runFlowGraphs(scene, flowGraphs, container.animationGroups);
                container.flowGraphRuntimes = runtimes;
                _registerAssetContainerSceneCleanup(container, scene, () => {
                    removed = true;
                    active.forEach((runtime) => detachFlowGraph(scene, runtime));
                    active = [];
                });
                void runtimes.then(
                    (loaded) => {
                        if (removed) {
                            loaded.forEach((runtime) => detachFlowGraph(scene, runtime));
                        } else {
                            active = loaded;
                        }
                    },
                    () => undefined
                );
            },
        };
    },
};

export default feature;
