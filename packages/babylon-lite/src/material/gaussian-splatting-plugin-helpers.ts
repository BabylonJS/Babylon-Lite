export const GAUSSIAN_SPLATTING_MAX_PART_COUNT = 128;

export function getGaussianSplattingPartIndexVaryingDeclaration(wgsl: boolean): string {
    const declaration = wgsl ? "varying vPartIndex: f32;" : "varying float vPartIndex;";
    return `
#if !defined(VPARTINDEX_VARYING_DECLARED)
#define VPARTINDEX_VARYING_DECLARED
${declaration}
#endif
`;
}
