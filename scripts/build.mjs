import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const r = (p) => path.join(root, p);

mkdirSync(r('dist/main'), { recursive: true });
mkdirSync(r('dist/preload'), { recursive: true });
mkdirSync(r('dist/renderer'), { recursive: true });

const common = { bundle: true, minify: false, sourcemap: false, logLevel: 'error' };

await build({ ...common, entryPoints: [r('src/main/index.ts')], platform: 'node', format: 'cjs', external: ['electron'], outfile: r('dist/main/index.cjs') });
await build({ ...common, entryPoints: [r('src/preload/index.ts')], platform: 'node', format: 'cjs', external: ['electron'], outfile: r('dist/preload/index.cjs') });
await build({ ...common, entryPoints: [r('src/renderer/App.tsx')], platform: 'browser', format: 'iife', outfile: r('dist/renderer/index.js') });

copyFileSync(r('src/renderer/index.html'), r('dist/renderer/index.html'));
copyFileSync(r('src/renderer/style.css'), r('dist/renderer/style.css'));
copyFileSync(r('resources/manual.html'), r('dist/manual.html'));
console.log('build ok');
