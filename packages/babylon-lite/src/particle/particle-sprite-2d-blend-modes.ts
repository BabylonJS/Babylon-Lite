/**
 * Optional exact Babylon.js particle blending for the pure-2D SpriteRenderer bridge.
 * The baseline bridge remains independent and keeps its compact fallback mapping.
 */
import { createSprite2DLayer, type Sprite2DLayer } from "../sprite/sprite-2d.js";
import type { SpriteBlendDescriptor } from "../sprite/sprite-blend.js";
import { createSprite2DCustomShader, type Sprite2DCustomShader } from "../sprite/sprite-custom-shader.js";
import { addSpriteRendererLayer, removeSpriteRendererLayer, type SpriteRenderer } from "../sprite/sprite-renderer.js";
import type { NodeParticleSet } from "./node/node-particle.js";
import { createParticleBlend } from "./particle-blend.js";
import {
    createParticleSprite2DBridge,
    syncParticleSprite2DBridge,
    type ParticleSprite2DBridge,
    type ParticleSprite2DBridgeOptions,
    type RegisterNodeParticleSet2DOptions,
} from "./particle-sprite-2d.js";
import type { ParticleSystem } from "./particle-system.js";
import { animateParticleSystem, startParticleSystem } from "./particle-system.js";

const FRAME_MS = 1000 / 60;
const MULTIPLY_FRAGMENT_WGSL = `let sampled = textureSample(atlasTex, atlasSamp, in.uv);
let baseColor = sampled * in.tint * L.opacityMul;
let sourceAlpha = sampled.a * in.tint.a * L.opacityMul.a;
return vec4f(baseColor.rgb * sourceAlpha + vec3f(1.0) * (1.0 - sourceAlpha), baseColor.a);`;

let _multiplyShader: Sprite2DCustomShader | null = null;

/** One logical exact-blend bridge. Mode 4 owns two ordered render-pass layers. */
export interface ParticleSprite2DBlendModesBridge {
    readonly system: ParticleSystem;
    /** Primary layer: Multiply for mode 4. Mutate its presentation state for the logical bridge. */
    readonly layer: Sprite2DLayer;
    /** Ordered render-pass layers. Mode 4 is `[Multiply, Add]`; every other mode contains only `layer`. */
    readonly layers: readonly Sprite2DLayer[];
    pixelsPerUnit: number;
    originPx: [number, number];
    invertY: boolean;
    /** @internal Baseline packed bridges, one per render pass. */
    readonly _passes: readonly ParticleSprite2DBridge[];
}

/** Managed exact-blend binding returned by {@link registerNodeParticleSet2DWithBlendModes}. */
export interface NodeParticleSet2DBlendModesBinding {
    /** @internal */
    readonly _entityType: "node-particle-set-2d-blend-modes-binding";
    readonly bridges: readonly ParticleSprite2DBlendModesBridge[];
    active: boolean;
    /** @internal */
    _dispose: () => void;
}

function getMultiplyShader(): Sprite2DCustomShader {
    return (_multiplyShader ??= createSprite2DCustomShader({ fragment: MULTIPLY_FRAGMENT_WGSL }));
}

function setLayerBlendMode(layer: Sprite2DLayer, blendMode: SpriteBlendDescriptor): void {
    (layer as { blendMode: SpriteBlendDescriptor }).blendMode = blendMode;
}

function attachMultiplyShader(layer: Sprite2DLayer): void {
    (layer as { customShader?: Sprite2DCustomShader }).customShader = getMultiplyShader();
    layer.shaderParams = [0, 0, 0, 0];
}

function createAdditionalPass(primary: ParticleSprite2DBridge, blendMode: SpriteBlendDescriptor): ParticleSprite2DBridge {
    const source = primary.layer;
    const layer = createSprite2DLayer(source.atlas, {
        capacity: primary.system.buffer.capacity,
        blendMode,
        opacity: source.opacity,
        visible: source.visible,
        order: source.order,
        view: source.view,
        depth: "none",
        pivot: [source.pivot[0], source.pivot[1]],
    });
    return {
        system: primary.system,
        layer,
        pixelsPerUnit: primary.pixelsPerUnit,
        originPx: [primary.originPx[0], primary.originPx[1]],
        invertY: primary.invertY,
    };
}

/** Create an exact-blend pure-2D bridge for one particle system. */
export function createParticleSprite2DBridgeWithBlendModes(system: ParticleSystem, options: ParticleSprite2DBridgeOptions = {}): ParticleSprite2DBlendModesBridge {
    const primary = createParticleSprite2DBridge(system, options);
    const blendMode = createParticleBlend(system.blendMode);
    setLayerBlendMode(primary.layer, blendMode);
    if (blendMode._particlePasses) {
        attachMultiplyShader(primary.layer);
    }

    const passes: ParticleSprite2DBridge[] = [primary];
    if (blendMode._particlePasses === 2) {
        passes.push(createAdditionalPass(primary, createParticleBlend(2)));
    }
    return {
        system,
        layer: primary.layer,
        layers: passes.map((pass) => pass.layer),
        pixelsPerUnit: primary.pixelsPerUnit,
        originPx: primary.originPx,
        invertY: primary.invertY,
        _passes: passes,
    };
}

function validateBridgeForSync(bridge: ParticleSprite2DBlendModesBridge): void {
    if (!(bridge.pixelsPerUnit > 0) || !Number.isFinite(bridge.pixelsPerUnit)) {
        throw new Error(`syncParticleSprite2DBridgeWithBlendModes: pixelsPerUnit must be a positive finite number, got ${bridge.pixelsPerUnit}`);
    }
    if (!Number.isFinite(bridge.originPx[0]) || !Number.isFinite(bridge.originPx[1])) {
        throw new Error(`syncParticleSprite2DBridgeWithBlendModes: originPx must be finite, got [${bridge.originPx[0]}, ${bridge.originPx[1]}]`);
    }
    for (let i = 0; i < bridge.layers.length; i++) {
        if (bridge.layers[i]!._handleHooks) {
            throw new Error("syncParticleSprite2DBridgeWithBlendModes: bridge-owned layers cannot use the Sprite2D Handle API");
        }
    }
}

function copyLogicalState(bridge: ParticleSprite2DBlendModesBridge, pass: ParticleSprite2DBridge, copyPresentation: boolean): void {
    pass.pixelsPerUnit = bridge.pixelsPerUnit;
    pass.originPx[0] = bridge.originPx[0];
    pass.originPx[1] = bridge.originPx[1];
    pass.invertY = bridge.invertY;
    if (!copyPresentation) {
        return;
    }
    const source = bridge.layer;
    const target = pass.layer;
    target.opacity = source.opacity;
    target.visible = source.visible;
    target.order = source.order;
    target.view.positionPx[0] = source.view.positionPx[0];
    target.view.positionPx[1] = source.view.positionPx[1];
    target.view.zoom = source.view.zoom;
    target.view.rotation = source.view.rotation;
    target.pivot[0] = source.pivot[0];
    target.pivot[1] = source.pivot[1];
}

/** Synchronize every pass from the bridge's one logical mapping and primary presentation layer. */
export function syncParticleSprite2DBridgeWithBlendModes(bridge: ParticleSprite2DBlendModesBridge): void {
    validateBridgeForSync(bridge);
    for (let i = 0; i < bridge._passes.length; i++) {
        const pass = bridge._passes[i]!;
        copyLogicalState(bridge, pass, i !== 0);
        syncParticleSprite2DBridge(pass);
    }
}

/** Register an NPE set with exact Sprite2D blend modes and managed renderer lifetime. */
export function registerNodeParticleSet2DWithBlendModes(
    renderer: SpriteRenderer,
    set: NodeParticleSet,
    options: RegisterNodeParticleSet2DOptions = {}
): NodeParticleSet2DBlendModesBinding {
    const bridges = set.systems.map((system) => createParticleSprite2DBridgeWithBlendModes(system, options));
    for (const bridge of bridges) {
        syncParticleSprite2DBridgeWithBlendModes(bridge);
    }

    try {
        for (const bridge of bridges) {
            for (const layer of bridge.layers) {
                addSpriteRendererLayer(renderer, layer);
            }
        }
    } catch (error) {
        for (let bridgeIndex = bridges.length - 1; bridgeIndex >= 0; bridgeIndex--) {
            const layers = bridges[bridgeIndex]!.layers;
            for (let layerIndex = layers.length - 1; layerIndex >= 0; layerIndex--) {
                removeSpriteRendererLayer(renderer, layers[layerIndex]!);
            }
        }
        throw error;
    }

    if (options.autoStart ?? true) {
        for (const bridge of bridges) {
            startParticleSystem(bridge.system);
        }
    }

    const hook = (deltaMs: number): void => {
        const ratio = deltaMs > 0 ? deltaMs / FRAME_MS : 1;
        for (const bridge of bridges) {
            animateParticleSystem(bridge.system, ratio);
            syncParticleSprite2DBridgeWithBlendModes(bridge);
        }
    };
    renderer._beforeUpdate.push(hook);

    const binding: NodeParticleSet2DBlendModesBinding = {
        _entityType: "node-particle-set-2d-blend-modes-binding",
        bridges,
        active: true,
        _dispose: () => {
            const hookIndex = renderer._beforeUpdate.indexOf(hook);
            if (hookIndex !== -1) {
                renderer._beforeUpdate.splice(hookIndex, 1);
            }
            const callbackIndex = renderer._disposeCallbacks.indexOf(disposeWithRenderer);
            if (callbackIndex !== -1) {
                renderer._disposeCallbacks.splice(callbackIndex, 1);
            }
            for (const bridge of bridges) {
                for (const layer of bridge.layers) {
                    removeSpriteRendererLayer(renderer, layer);
                }
            }
        },
    };
    function disposeWithRenderer(): void {
        disposeNodeParticleSet2DBlendModesBinding(binding);
    }
    renderer._disposeCallbacks.push(disposeWithRenderer);
    return binding;
}

/** Detach an exact-blend renderer binding. Idempotent; systems and textures remain caller-owned. */
export function disposeNodeParticleSet2DBlendModesBinding(binding: NodeParticleSet2DBlendModesBinding): void {
    if (!binding.active) {
        return;
    }
    binding.active = false;
    binding._dispose();
}
