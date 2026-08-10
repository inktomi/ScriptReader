import { defineConfig } from 'vite';

export default defineConfig({
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
    exclude: ['@huggingface/transformers', 'kokoro-js', 'pdfjs-dist'],
  },
  build: {
    target: 'esnext',
  },
});
