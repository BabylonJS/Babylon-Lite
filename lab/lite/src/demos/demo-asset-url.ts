export function demoAssetUrl(path: string, moduleUrl: string): string {
    const url = new URL(path, moduleUrl);
    url.pathname = url.pathname.replace("/lite/bundle/demos/", "/bundle/demos/");
    return url.href;
}

export async function configureDemoDracoBase(moduleUrl: string): Promise<void> {
    const { setDracoBaseUrl } = await import("babylon-lite/loader-gltf/draco-decode.js");
    setDracoBaseUrl(demoAssetUrl("./", moduleUrl));
}
