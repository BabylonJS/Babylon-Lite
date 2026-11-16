export type UsdVisualAsset = "materials" | "analytic" | "skin";

const ANALYTIC_STAGE = `#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 1
    upAxis = "Y"
)
def Xform "World"
{
    def Cube "RightHanded"
    {
        double size = 2
        color3f[] primvars:displayColor = [(0.12, 0.55, 0.95)]
        double3 xformOp:translate = (-1.35, 1, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
    def Cube "LeftHanded"
    {
        double size = 2
        uniform token orientation = "leftHanded"
        color3f[] primvars:displayColor = [(0.95, 0.35, 0.12)]
        double3 xformOp:translate = (1.35, 1, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
}
`;

const SKIN_STAGE = `#usda 1.0
(
    defaultPrim = "Model"
    startTimeCode = 0
    endTimeCode = 24
    timeCodesPerSecond = 24
    metersPerUnit = 1
    upAxis = "Y"
)
def SkelRoot "Model" (
    prepend apiSchemas = ["SkelBindingAPI"]
)
{
    rel skel:animationSource = <Animation>
    def Mesh "Ribbon" (
        prepend apiSchemas = ["SkelBindingAPI"]
    )
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(-0.35, 1, 0), (0.35, 1, 0), (0.35, 2.5, 0), (-0.35, 2.5, 0)]
        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)] (
            interpolation = "vertex"
        )
        color3f[] primvars:displayColor = [(0.2, 0.75, 0.95)]
        matrix4d primvars:skel:geomBindTransform = (
            (1, 0, 0, 0),
            (0, 1, 0, 0),
            (0, 0, 1, 0),
            (0, 0, 0, 1)
        )
        int[] primvars:skel:jointIndices = [1, 1, 1, 1] (
            elementSize = 1
            interpolation = "vertex"
        )
        float[] primvars:skel:jointWeights = [1, 1, 1, 1] (
            elementSize = 1
            interpolation = "vertex"
        )
        rel skel:skeleton = </Model/Rig>
        uniform token subdivisionScheme = "none"
    }
    def Skeleton "Rig"
    {
        uniform token[] joints = ["Root", "Root/Tip"]
        uniform matrix4d[] bindTransforms = [
            (
                (1, 0, 0, 0),
                (0, 1, 0, 0),
                (0, 0, 1, 0),
                (0, 0, 0, 1)
            ),
            (
                (1, 0, 0, 0),
                (0, 1, 0, 0),
                (0, 0, 1, 0),
                (0, 1, 0, 1)
            )
        ]
        uniform matrix4d[] restTransforms = [
            (
                (1, 0, 0, 0),
                (0, 1, 0, 0),
                (0, 0, 1, 0),
                (0, 0, 0, 1)
            ),
            (
                (1, 0, 0, 0),
                (0, 1, 0, 0),
                (0, 0, 1, 0),
                (0, 1, 0, 1)
            )
        ]
    }
    def SkelAnimation "Animation"
    {
        uniform token[] joints = ["Root", "Root/Tip"]
        float3[] translations.timeSamples = {
            0: [(0, 0, 0), (0, 1, 0)],
            12: [(0, 0, 0), (0, 1, 0)],
            24: [(0, 0, 0), (0, 1, 0)]
        }
        quath[] rotations.timeSamples = {
            0: [(1, 0, 0, 0), (1, 0, 0, 0)],
            12: [(1, 0, 0, 0), (0.7071068, 0, 0, 0.7071068)],
            24: [(1, 0, 0, 0), (1, 0, 0, 0)]
        }
        half3[] scales.timeSamples = {
            0: [(1, 1, 1), (1, 1, 1)],
            12: [(1, 1, 1), (1, 1, 1)],
            24: [(1, 1, 1), (1, 1, 1)]
        }
    }
}
`;

/** Return a deterministic visual-parity source shared by Lite and Babylon.js. */
export function createUsdVisualSource(asset: UsdVisualAsset): string | File {
    if (asset === "materials") {
        return "https://cdn.babylonjs.com/babylonUsdImporter/testAssets/material-textures.usdz";
    }
    return new File([asset === "analytic" ? ANALYTIC_STAGE : SKIN_STAGE], `${asset}.usda`, { type: "application/octet-stream" });
}
