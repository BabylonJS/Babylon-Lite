export function parseShadoSceneSelection(rawValue: string | undefined, knownSceneIds: ReadonlySet<number>): Set<number> | null {
    if (rawValue === undefined) {
        return null;
    }
    if (rawValue.trim() === "") {
        return new Set();
    }

    const values = rawValue.split(",").map((value) => value.trim());
    const invalidValues = values.filter((value) => !/^\d+$/.test(value) || !knownSceneIds.has(Number(value)));
    if (invalidValues.length > 0) {
        throw new Error(`SHADO_SCENES contains invalid or unknown scene IDs: ${invalidValues.join(", ")}`);
    }
    return new Set(values.map(Number));
}
