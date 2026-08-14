import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// Cloudflare Workers refuses to deploy a static asset larger than this, and the
// error only surfaces at `wrangler deploy` time — the build itself is happy.
const WORKERS_MAX_ASSET_BYTES = 25 * 1024 * 1024;

// onnxruntime-web's emscripten glue ends with
// `new URL("ort-wasm-simd-threaded.<flavour>.wasm", import.meta.url)` as its
// last-resort way to locate the runtime binary. Vite treats that as an asset
// reference and copies the binary — 21 MB for the jsep flavour kokoro-js
// bundles, 25.9 MB for the asyncify flavour transformers-v4 bundles — into
// dist/assets.
//
// Nothing ever fetches them. Both transformers.js copies assign
// `env.backends.onnx.wasm.wasmPaths` to a cdn.jsdelivr.net prefix when their
// backend module is evaluated, and ORT only reaches the `new URL` fallback when
// wasmPaths is unset. So the two binaries are pure ballast — and the asyncify
// one is 0.9 MB over the Workers per-asset ceiling, which is what broke the
// deploy of 94d211a.
//
// Rebasing the fallback onto jsdelivr drops both from the bundle (Vite only
// emits an asset when the base is `import.meta.url`) and leaves the fallback
// working rather than pointing at a URL that would 404. That matters: this
// branch is live inside a ServiceWorkerGlobalScope, where transformers.js skips
// its wasmPaths default. Self-hosting instead is not an option here — the
// asyncify binary cannot be served from Workers assets at any size.
const ORT_WASM_URL = /new URL\(\s*(["'])(ort-wasm[\w.-]*\.(?:wasm|mjs))\1\s*,\s*import\.meta\.url\s*\)/g;

// The version has to match the glue exactly — an ORT binary paired with glue
// from another build fails to instantiate — so resolve it the same way the
// bundler that produced the file did, from the nearest onnxruntime-web.
function resolveOrtVersion(fromFile) {
  let dir = path.dirname(fromFile);
  for (;;) {
    const manifest = path.join(dir, 'node_modules', 'onnxruntime-web', 'package.json');
    if (fs.existsSync(manifest)) {
      return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function ortWasmFromCdn() {
  return {
    name: 'ort-wasm-from-cdn',
    enforce: 'pre',
    transform(code, id) {
      if (!code.includes('ort-wasm')) return null;
      ORT_WASM_URL.lastIndex = 0;
      if (!ORT_WASM_URL.test(code)) return null;

      const version = resolveOrtVersion(id);
      if (!version) {
        throw new Error(
          `[ort-wasm-from-cdn] ${id} references an ORT wasm binary but no onnxruntime-web could be resolved from it.`,
        );
      }
      // Each bundle embeds the version of the ORT it was built against. If it
      // does not match what resolution found, the CDN copy would be the wrong
      // build — fail loudly rather than ship a runtime that cannot start.
      if (!code.includes(version)) {
        throw new Error(
          `[ort-wasm-from-cdn] resolved onnxruntime-web@${version} for ${id}, but that version string does not appear in the file. Re-check which ORT build it bundles before trusting the CDN URL.`,
        );
      }

      const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
      return {
        code: code.replace(
          ORT_WASM_URL,
          (_match, quote, file) => `new URL(${quote}${file}${quote}, ${quote}${base}${quote})`,
        ),
        map: null,
      };
    },
  };
}

// kokoro-js phonemizes through `phonemizer`, which ships espeak-ng as wasm2js:
// the whole synthesiser is plain JavaScript in Binaryen's output shape, where a
// labelled block's last statement is often a `continue` or `return` that jumps
// past the code following the block.
//
// Rolldown's tree-shaker reads those jumps as redundant and deletes them, so
// loops that should repeat run once and functions that should return fall
// through into the abort trap emitted after them. An unminified build drops ~12
// `continue`s and ~10 `return`s from that one file. espeak still starts and its
// data package still mounts — it just finds no voices, so every synthesis in a
// built app fails with:
//
//   Invalid language identifier: "en-us". Should be one of: .
//
// Nothing narrower than `treeshake: false` avoids it: none of the treeshake
// sub-options help, `moduleSideEffects: 'no-treeshake'` does not either, and
// Vite does not forward build.rollupOptions.treeshake to rolldown regardless.
// Turning tree-shaking off for the whole worker would drag all of
// transformers.js in with it.
//
// So keep the file away from the bundler: emit it verbatim as an asset and
// reach it through a dynamic import, which rolldown leaves alone. What runs is
// then the same bytes dev serves from node_modules. This is why the worker
// build must be `format: 'es'` — the asset URL arrives via import.meta, which
// an iife worker chunk replaces with `{}`.
const PHONEMIZER_VERBATIM = '\0phonemizer-verbatim:';

function phonemizerVerbatim() {
  return {
    name: 'phonemizer-verbatim',
    enforce: 'pre',
    // Dev serves the file unbundled from node_modules already, and emitFile has
    // no meaning there.
    apply: 'build',
    async resolveId(source, importer, options) {
      if (source !== 'phonemizer') return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved ? PHONEMIZER_VERBATIM + resolved.id : null;
    },
    load(id) {
      if (!id.startsWith(PHONEMIZER_VERBATIM)) return null;
      const ref = this.emitFile({
        type: 'asset',
        name: 'phonemizer.js',
        source: fs.readFileSync(id.slice(PHONEMIZER_VERBATIM.length)),
      });
      // Started eagerly so the fetch overlaps model loading rather than landing
      // on the first line the listener is waiting for. A rejection here is
      // deliberately left for the call site to surface.
      return `const url = import.meta.ROLLUP_FILE_URL_${ref};
let loading;
const load = () => (loading ??= import(/* @vite-ignore */ url));
load().catch(() => {});
export async function phonemize(...args) { return (await load()).phonemize(...args); }
export async function list_voices(...args) { return (await load()).list_voices(...args); }
`;
    },
  };
}

// A guard rather than a fix: any future dependency that drags an oversized
// binary into dist should fail here, in a build anyone can run, instead of in
// the deploy log.
function assertWorkersAssetSizes() {
  let outDir;
  return {
    name: 'assert-workers-asset-sizes',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const oversized = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (fs.statSync(full).size > WORKERS_MAX_ASSET_BYTES) {
            oversized.push(`${path.relative(outDir, full)} (${(fs.statSync(full).size / 1024 / 1024).toFixed(1)} MiB)`);
          }
        }
      };
      if (!fs.existsSync(outDir)) return;
      walk(outDir);
      if (oversized.length) {
        throw new Error(
          `Cloudflare Workers rejects assets over 25 MiB, and these would fail the deploy:\n  ${oversized.join('\n  ')}`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [ortWasmFromCdn(), phonemizerVerbatim(), assertWorkersAssetSizes()],
  worker: {
    // Every worker is created with `{ type: 'module' }`, so this matches how
    // they are actually loaded. It is also what lets phonemizerVerbatim reach
    // its asset: an iife chunk has no usable import.meta.
    format: 'es',
    // Both engines reach ORT from inside a worker, and a worker is built by a
    // separate bundle that does not inherit `plugins` — without this the
    // rewrite silently does nothing and the binaries come back.
    plugins: () => [ortWasmFromCdn(), phonemizerVerbatim()],
  },
  server: {
    port: 5173,
    open: false,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      // Matches what public/_headers serves in production. `require-corp` here
      // made dev stricter than prod, so cross-origin behaviour could not be
      // reproduced locally.
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  optimizeDeps: {
    // transformers-v4 belongs here for the same reason as its v3 sibling: it is
    // only ever imported from a worker, and pre-bundling it rewrites the module
    // that `ortWasmFromCdn` needs to transform, so the ORT wasm URL rebase
    // silently stops applying in dev.
    exclude: ['@huggingface/transformers', 'transformers-v4', 'kokoro-js', 'pdfjs-dist'],
  },
  build: {
    target: 'esnext',
  },
});
