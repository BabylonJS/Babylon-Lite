import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { writeFileSync } from 'fs';
import dts from 'vite-plugin-dts';

/** Emit a publish-ready package.json into the build output directory. */
function emitPackageJson(outDir: string): Plugin {
  return {
    name: 'emit-package-json',
    writeBundle() {
      const pkg = {
        name: '@babylonjs/lite',
        version: '0.1.0',
        type: 'module',
        main: './index.js',
        module: './index.js',
        types: './index.d.ts',
        exports: {
          '.': {
            import: './index.js',
            types: './index.d.ts',
          },
        },
        sideEffects: false,
        dependencies: {
          draco3d: '^1.5.7',
          'manifold-3d': '3.4.0',
        },
      };
      writeFileSync(resolve(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    },
  };
}

export default defineConfig(({ mode }) => {
  const outDir = mode === 'prod' ? 'dist/prod' : 'dist';
  const isWatch = process.argv.includes('--watch');
  return {
    build: {
      lib: {
        entry: resolve(__dirname, 'src/index.ts'),
        formats: ['es'],
        fileName: 'index',
      },
      outDir,
      rollupOptions: {
        external: [],
      },
      sourcemap: true,
      minify: mode === 'prod' ? 'esbuild' : false,
    },
    plugins: [
      dts({
        rollupTypes: !isWatch,
        tsconfigPath: resolve(__dirname, 'tsconfig.json'),
        outDir,
      }),
      emitPackageJson(outDir),
    ],
  };
});
