/** Number of point instances in the shared USD loader comparison scene. */
export const USD_PERFORMANCE_INSTANCE_COUNT = 10_000;

/** Build a deterministic, self-contained USDA point-instancer stage. */
export function createUsdPerformanceStage(): File {
    const width = Math.sqrt(USD_PERFORMANCE_INSTANCE_COUNT);
    const positions: string[] = [];
    for (let index = 0; index < USD_PERFORMANCE_INSTANCE_COUNT; index++) {
        const x = index % width;
        const z = Math.floor(index / width);
        positions.push(`(${x - width / 2},0,${z - width / 2})`);
    }
    const repeated = (value: string): string => new Array<string>(USD_PERFORMANCE_INSTANCE_COUNT).fill(value).join(",");
    const source = `#usda 1.0
(
    defaultPrim = "Scatter"
    metersPerUnit = 1
    upAxis = "Y"
)
def PointInstancer "Scatter"
{
    int[] protoIndices = [${repeated("0")}]
    point3f[] positions = [${positions.join(",")}]
    quath[] orientations = [${repeated("(1,0,0,0)")}]
    float3[] scales = [${repeated("(1,1,1)")}]
    rel prototypes = </Scatter/Prototypes/Marker>
    def Scope "Prototypes"
    {
        def Xform "Marker"
        {
            def Mesh "Triangle"
            {
                int[] faceVertexCounts = [3]
                int[] faceVertexIndices = [0,1,2]
                point3f[] points = [(-0.35,0,0),(0.35,0,0),(0,0.7,0)]
                color3f[] primvars:displayColor = [(0.15,0.55,0.95)]
                uniform token subdivisionScheme = "none"
            }
        }
    }
}
`;
    return new File([source], "point-instancer-performance.usda", { type: "application/octet-stream" });
}
