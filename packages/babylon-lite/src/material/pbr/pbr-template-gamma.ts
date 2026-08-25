export function gammaBaseColor(baseColorFactorRgb: string, baseColorFactorAlpha: string, vertexColorMod: string): string {
    return `var baseColor=pow(baseColorSample.rgb,vec3<f32>(2.2))${baseColorFactorRgb};
var alpha=baseColorSample.a${baseColorFactorAlpha};${vertexColorMod}`;
}
