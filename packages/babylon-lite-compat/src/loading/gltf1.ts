import { unsupported } from "../error.js";

const GLTF1_UNSUPPORTED = "Babylon Lite only implements glTF 2.0; glTF 1.0 needs a separate parser, extension registry, and material conversion subsystem.";

export class GLTFLoaderBase {
    public constructor(..._args: unknown[]) {
        unsupported("GLTF1.GLTFLoaderBase", GLTF1_UNSUPPORTED);
    }
}

export class GLTFLoader {
    public constructor(..._args: unknown[]) {
        unsupported("GLTF1.GLTFLoader", GLTF1_UNSUPPORTED);
    }
}

export class GLTFBinaryExtension {
    public constructor(..._args: unknown[]) {
        unsupported("GLTF1.GLTFBinaryExtension", GLTF1_UNSUPPORTED);
    }
}

export class GLTFMaterialsCommonExtension {
    public constructor(..._args: unknown[]) {
        unsupported("GLTF1.GLTFMaterialsCommonExtension", GLTF1_UNSUPPORTED);
    }
}

export function RegisterGLTF1Loader(): void {
    unsupported("GLTF1.RegisterGLTF1Loader", GLTF1_UNSUPPORTED);
}

export function RegisterGLTFBinaryExtension(): void {
    unsupported("GLTF1.RegisterGLTFBinaryExtension", GLTF1_UNSUPPORTED);
}

export function RegisterGLTFMaterialsCommonExtension(): void {
    unsupported("GLTF1.RegisterGLTFMaterialsCommonExtension", GLTF1_UNSUPPORTED);
}
