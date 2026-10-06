import * as fs from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  }),
  esbuild.context({
    ...common,
    entryPoints: ['media/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['media/main.css'],
    outfile: 'dist/main.css',
    loader: { '.ttf': 'file' },
    assetNames: '[name]',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  if (production) {
    for (const file of ['dist/extension.js.map', 'dist/webview.js.map', 'dist/main.css.map']) {
      fs.rmSync(file, { force: true });
    }
  }
}
