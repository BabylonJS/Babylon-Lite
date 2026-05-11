import type { Material, MaterialOrView, MaterialRenderFeatures, MaterialView } from "./material.js";

/** Create a material view that references source state and overrides render features exactly. */
export function createMaterialView(source: MaterialOrView, renderFeatures: MaterialRenderFeatures): MaterialView {
    const src = getMaterialSource(source);
    const view: MaterialView = {
        source: src,
        _renderFeatures: {
            features: renderFeatures.features,
            features2: renderFeatures.features2,
        },
    };
    (src._views ??= []).push(view);
    return view;
}

export function isMaterialView(material: MaterialOrView): material is MaterialView {
    const maybeView = material as Partial<MaterialView>;
    return !!maybeView.source && !!maybeView._renderFeatures;
}

export function getMaterialSource(material: MaterialOrView): Material {
    return isMaterialView(material) ? material.source : material;
}
