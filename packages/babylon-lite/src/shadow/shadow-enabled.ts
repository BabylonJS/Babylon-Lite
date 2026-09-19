import { F32 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import type { ShadowGenerator, ShadowGeneratorEnabledState, ShadowTaskInternalState } from "./shadow-generator.js";

/** Enable or disable a shadow generator at runtime while preserving its receiver bindings and resources. */
export function setShadowGeneratorEnabled(generator: ShadowGenerator, enabled: boolean): void {
    let state = generator._runtimeEnabledState;
    if (!state) {
        const renderShadowMap = generator._renderShadowMap;
        if (!renderShadowMap) {
            throw new Error("setShadowGeneratorEnabled requires a configured shadow generator.");
        }
        const installedState: ShadowGeneratorEnabledState = {
            enabled: true,
            uploadData: new F32(1),
            renderShadowMap,
        };
        state = installedState;
        generator._runtimeEnabledState = state;
        const renderWhenEnabled = (engine: EngineContext, taskState: ShadowTaskInternalState): number =>
            syncShadowGeneratorEnabled(engine, generator, taskState, installedState) ? installedState.renderShadowMap(engine, taskState) : 0;
        generator._renderShadowMap = renderWhenEnabled;
        const previousReplacer = generator._replaceShadowTaskHooks;
        generator._replaceShadowTaskHooks = (ensure, render) => {
            if (previousReplacer) {
                previousReplacer(ensure, render);
            } else {
                generator._ensureShadowTaskState = ensure;
                installedState.renderShadowMap = render;
            }
        };
    }
    if (state.enabled === enabled) {
        return;
    }
    state.enabled = enabled;
    generator._version++;
}

function syncShadowGeneratorEnabled(engine: EngineContext, generator: ShadowGenerator, taskState: ShadowTaskInternalState, state: ShadowGeneratorEnabledState): boolean {
    if (state.uploadedEnabled === state.enabled && state.uploadedUbo === generator._shadowUBO) {
        return state.enabled;
    }
    const darkness = state.enabled ? generator._shadowsInfo[0]! : 1;
    state.uploadData[0] = darkness;
    const floatOffset = generator._shadowType === "csm" ? 72 : 20;
    engine._device.queue.writeBuffer(generator._shadowUBO, floatOffset * 4, state.uploadData as Float32Array<ArrayBuffer>);
    if (generator._shadowType === "csm") {
        const csmData = (taskState as ShadowTaskInternalState & { _uboData?: Float32Array })._uboData;
        if (csmData) {
            csmData[72] = darkness;
            const callbacks = generator._onReceiverData;
            if (callbacks) {
                for (let index = 0; index < callbacks.length; index++) {
                    callbacks[index]!(csmData);
                }
            }
        }
    }
    state.uploadedEnabled = state.enabled;
    state.uploadedUbo = generator._shadowUBO;
    return state.enabled;
}
