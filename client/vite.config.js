import { defineConfig } from 'vite';

// Deployed under daniyalzia.co.uk/gambit — assets must resolve from that
// subpath in production. Left at '/' for the dev server so local dev
// (launch.json points at localhost:5183/) is unaffected.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/gambit/' : '/',
}));
