import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const page = (name) => resolve(import.meta.dirname, `${name}.html`);

export default defineConfig({
  // relative base so dist/ can be served from any sub-path
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { index: page('index'), polls: page('polls'), trends: page('trends'), answers: page('answers'), pdg: page('pdg'), hello: page('hello') },
    },
  },
});
