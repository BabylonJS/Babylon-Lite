import type { Material, MaterialRenderFeatures, MaterialView } from "./material.js";

/** Create a material view that references source state and overrides render features exactly. */
export function createMaterialView(source: Material, renderFeatures: MaterialRenderFeatures): MaterialView {
    const src = getMaterialSource(source);
    const view = Object.create(src, {
        source: { value: src, enumerable: true },
        _renderFeatures: {
            value: {
                features: renderFeatures.features,
                features2: renderFeatures.features2,
            },
            writable: true,
            enumerable: true,
            configurable: true,
        },
    }) as MaterialView;
    return view;
}

export function isMaterialView(material: Material): material is MaterialView {
    const maybeView = material as Partial<MaterialView>;
    return !!maybeView.source && !!maybeView._renderFeatures;
}

export function getMaterialSource(material: Material): Material {
    return isMaterialView(material) ? material.source : material;
}
