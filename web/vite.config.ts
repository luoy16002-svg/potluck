import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the build works from a GitHub Pages subpath.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { fs: { allow: ['..'] } },
});
