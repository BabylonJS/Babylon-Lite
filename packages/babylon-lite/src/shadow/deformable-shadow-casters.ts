import type { Aabb } from "../math/aabb.js";
import type { Mesh } from "../mesh/mesh.js";
import type { ShadowGenerator, ShadowTaskInternalState } from "./shadow-generator.js";

export interface DeformableShadowBoundsProvider {
    readonly kind: number;
    applies(mesh: Mesh): boolean;
    getLocalBounds(mesh: Mesh): Aabb | null;
}

interface ShadowMeshEntry {
    readonly source: Mesh;
    readonly shadow: Mesh;
    readonly provider: DeformableShadowBoundsProvider;
}

interface DeformableShadowState {
    readonly providers: DeformableShadowBoundsProvider[];
    readonly preload: NonNullable<ShadowGenerator["_preloadShadowTask"]>;
    readonly ensure: NonNullable<ShadowGenerator["_ensureShadowTaskState"]>;
    readonly render: NonNullable<ShadowGenerator["_renderShadowMap"]>;
    poseVersion: number;
    sourceMeshes?: readonly Mesh[];
    shadowMeshes?: readonly Mesh[];
    entries?: ShadowMeshEntry[];
}

let states: WeakMap<ShadowGenerator, DeformableShadowState> | null = null;

function updateShadowMesh(entry: ShadowMeshEntry): void {
    const bounds = entry.provider.getLocalBounds(entry.source);
    entry.shadow.boundMin = bounds?.[0] ?? entry.source.boundMin;
    entry.shadow.boundMax = bounds?.[1] ?? entry.source.boundMax;
}

function createShadowMesh(source: Mesh, provider: DeformableShadowBoundsProvider, state: DeformableShadowState): ShadowMeshEntry {
    const shadow = Object.create(source) as Mesh;
    Object.defineProperty(shadow, "worldMatrixVersion", {
        get: () => source.worldMatrixVersion + state.poseVersion,
    });
    const entry = { source, shadow, provider };
    updateShadowMesh(entry);
    return entry;
}

function mapCasterMeshes(state: DeformableShadowState, casterMeshes: readonly Mesh[]): readonly Mesh[] {
    if (state.sourceMeshes === casterMeshes) {
        return state.shadowMeshes!;
    }
    const entries: ShadowMeshEntry[] = [];
    const shadowMeshes = casterMeshes.map((mesh) => {
        const provider = state.providers.find((candidate) => candidate.applies(mesh));
        if (!provider) {
            return mesh;
        }
        const entry = createShadowMesh(mesh, provider, state);
        entries.push(entry);
        return entry.shadow;
    });
    state.sourceMeshes = casterMeshes;
    state.shadowMeshes = shadowMeshes;
    state.entries = entries;
    return shadowMeshes;
}

function prepareExistingState(generator: ShadowGenerator, state: DeformableShadowState): void {
    const existing = generator._shadowTaskState;
    if (existing && existing._casterMeshes === state.sourceMeshes && state.shadowMeshes) {
        existing._casterMeshes = state.shadowMeshes;
    }
}

function restoreSourceCasters(taskState: ShadowTaskInternalState, casterMeshes: readonly Mesh[]): void {
    taskState._casterMeshes = casterMeshes;
}

/** @internal Register one deformable-caster bounds provider on a shadow generator. */
export function enableDeformableShadowBounds(generator: ShadowGenerator, provider: DeformableShadowBoundsProvider): void {
    let state = states?.get(generator);
    if (state) {
        if (!state.providers.some((candidate) => candidate.kind === provider.kind)) {
            state.providers.push(provider);
            state.providers.sort((a, b) => b.kind - a.kind);
            state.sourceMeshes = undefined;
        }
        return;
    }
    const preload = generator._preloadShadowTask;
    const ensure = generator._ensureShadowTaskState;
    const render = generator._renderShadowMap;
    if (!preload || !ensure || !render) {
        throw new Error("Deformable shadows require a fully initialized shadow generator");
    }
    state = {
        providers: [provider],
        preload,
        ensure,
        render,
        poseVersion: 0,
    };
    (states ??= new WeakMap()).set(generator, state);

    generator._preloadShadowTask = (casterMeshes) => preload(mapCasterMeshes(state!, casterMeshes));
    generator._ensureShadowTaskState = (engine, scene, casterMeshes) => {
        prepareExistingState(generator, state!);
        const shadowMeshes = mapCasterMeshes(state!, casterMeshes);
        const taskState = ensure(engine, scene, shadowMeshes);
        restoreSourceCasters(taskState, casterMeshes);
        return taskState;
    };
    generator._renderShadowMap = (engine, taskState) => {
        const shadowMeshes = state!.shadowMeshes;
        const sourceMeshes = state!.sourceMeshes;
        if (!shadowMeshes || !sourceMeshes) {
            return render(engine, taskState);
        }
        state!.poseVersion++;
        for (const entry of state!.entries ?? []) {
            updateShadowMesh(entry);
        }
        taskState._casterMeshes = shadowMeshes;
        try {
            return render(engine, taskState);
        } finally {
            restoreSourceCasters(taskState, sourceMeshes);
        }
    };
}
