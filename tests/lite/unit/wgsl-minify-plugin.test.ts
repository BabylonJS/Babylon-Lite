import { describe, expect, it } from "vitest";
import { transformTaggedWgsl } from "../../../scripts/wgsl-minify-plugin";

describe("tagged WGSL minification", () => {
    it("minifies only an imported wgsl tag and preserves interpolations", () => {
        const source = `
import { wgsl } from "../shader/wgsl.js";
const body = wgsl\`
    // Body comment
    let value = input.value;
\`;
const shader = wgsl\`
    /* Shader comment */
    @fragment
    fn main() -> @location(0) vec4f {
        \${body}
        return vec4f(value);
    }
\`;
`;

        const result = transformTaggedWgsl(source, "shader.ts");

        expect(result).not.toBeNull();
        expect(result!.code).not.toContain("wgsl`");
        expect(result!.code).not.toContain("Body comment");
        expect(result!.code).not.toContain("Shader comment");
        expect(result!.code).toContain("const body = `let value=input.value;`");
        expect(result!.code).toContain("${body}");
        expect(result!.code).toContain("@fragment fn main()->@location(0)vec4f{");
        expect(result!.map).toBeDefined();
    });

    it("handles aliased and nested tags without touching unrelated templates", () => {
        const source = `
import { wgsl as shader } from "../shader/wgsl.js";
const html = htmlTag\`https://example.com/a path\`;
const projected = enabled
    ? shader\`\${body}
        let wp = projectedWorld;\`
    : shader\`let wp = originalWorld;\`;
const result = shader\`
    @vertex fn main() {
        \${projected}
    }
\`;
`;

        const result = transformTaggedWgsl(source, "shader.ts");

        expect(result).not.toBeNull();
        expect(result!.code).toContain("htmlTag`https://example.com/a path`");
        expect(result!.code).not.toContain("shader`");
        expect(result!.code).toContain("`${body} let wp=projectedWorld;`");
        expect(result!.code).toContain("`let wp=originalWorld;`");
        expect(result!.code).toContain("`@vertex fn main(){${projected}}`");
    });

    it("minifies escaped newlines in tagged template sections", () => {
        const source = `
import { wgsl } from "../shader/wgsl.js";
const shader = wgsl\`\${body}\\nlet wp = projectedWorld;\`;
`;

        const result = transformTaggedWgsl(source, "shader.ts");

        expect(result).not.toBeNull();
        expect(result!.code).toContain("`${body} let wp=projectedWorld;`");
        expect(result!.code).not.toContain("\\n");
    });

    it("rejects local bindings that shadow the imported tag", () => {
        const source = `
import { wgsl as shader } from "../shader/wgsl.js";
function render(shader: (parts: TemplateStringsArray) => string) {
    return shader\`not WGSL\`;
}
`;

        expect(() => transformTaggedWgsl(source, "shader.ts")).toThrow(/Imported WGSL tag "shader" is shadowed/);
    });

    it("rejects comments that cross an interpolation boundary", () => {
        const source = `
import { wgsl } from "../shader/wgsl.js";
const shader = wgsl\`// unsafe \${body}\`;
`;

        expect(() => transformTaggedWgsl(source, "shader.ts")).toThrow(/WGSL line comments cannot cross/);
    });

    it("preserves runtime injection markers while stripping ordinary block comments", () => {
        const source = `
import { wgsl } from "../shader/wgsl.js";
const shader = wgsl\`/*SU*/
/* explanatory comment */
@vertex fn main() {}\`;
`;

        const result = transformTaggedWgsl(source, "shader.ts");

        expect(result).not.toBeNull();
        expect(result!.code).toContain("`/*SU*/@vertex fn main(){}`");
        expect(result!.code).not.toContain("explanatory comment");
    });

    it("ignores templates when the wgsl helper is not imported", () => {
        const source = "const wgsl = tag; const shader = wgsl`https://example.com/a path`;";

        expect(transformTaggedWgsl(source, "shader.ts")).toBeNull();
    });
});
