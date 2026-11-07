// Bundles the Studio with esbuild: src/main.tsx (+ its CSS) → dist/assets/<name>-<hash>.{js,css} plus dist/index.html
// rewritten to point at the hashed files. `--watch` rebuilds on change (scripts/dev.sh runs it next to the daemon).
// Languages for the editor are loaded lazily (@codemirror/language-data), hence ESM output with code splitting.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
const outdir = path.join(here, 'dist');
const template = path.join(here, 'src', 'index.html');

/** Write dist/index.html from the template and drop stale hashed files, after every successful build. */
const htmlPlugin = {
  name: 'studio-html',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length || !result.metafile) return;
      const outputs = Object.keys(result.metafile.outputs).map((p) => path.resolve(p));
      const rel = (p) => path.relative(outdir, p).split(path.sep).join('/');
      const entry = outputs.find((p) => result.metafile.outputs[path.relative(process.cwd(), p)]?.entryPoint?.endsWith('src/main.tsx'));
      const css = outputs.find((p) => p.endsWith('.css'));
      if (!entry) return;
      let html = fs.readFileSync(template, 'utf8');
      html = html.replace('{{JS}}', rel(entry)).replace('{{CSS}}', css ? `<link rel="stylesheet" href="${rel(css)}">` : '');
      fs.writeFileSync(path.join(outdir, 'index.html'), html);
      // keep the assets folder to what this build produced (old hashes are unreachable and only confuse the cache)
      const keep = new Set(outputs);
      const assets = path.join(outdir, 'assets');
      if (fs.existsSync(assets)) {
        for (const f of fs.readdirSync(assets)) {
          const full = path.join(assets, f);
          if (!keep.has(full)) fs.rmSync(full, { force: true });
        }
      }
      const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
      const size = outputs.filter((p) => /\.(js|css)$/.test(p)).reduce((n, p) => n + fs.statSync(p).size, 0);
      console.log(
        `[studio] built ${rel(entry)}${css ? ` + ${rel(css)}` : ''} (${outputs.length} files, ${kb(size)})${dev ? ' [dev]' : ''}`,
      );
    });
  },
};

const ctx = await esbuild.context({
  absWorkingDir: here,
  entryPoints: [path.join(here, 'src', 'main.tsx')],
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir,
  entryNames: 'assets/[name]-[hash]',
  chunkNames: 'assets/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  metafile: true,
  minify: !dev,
  sourcemap: dev ? 'inline' : 'linked',
  target: ['es2022', 'chrome110', 'firefox115', 'safari16'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  loader: { '.woff2': 'file', '.svg': 'file' },
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [htmlPlugin],
});

fs.mkdirSync(outdir, { recursive: true });
if (watch) {
  await ctx.watch();
  console.log('[studio] watching src/ for changes');
} else {
  const result = await ctx.rebuild();
  await ctx.dispose();
  if (result.errors.length) process.exit(1);
}
