import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Each app builds to its own self-contained HTML file that works offline (file://):
//   vite build             → dist/index.html  (lathe)
//   vite build --mode mill → dist/mill.html   (milling)
export default defineConfig(({ mode }) => {
  const mill = mode === 'mill';
  return {
    plugins: [viteSingleFile()],
    build: {
      chunkSizeWarningLimit: 4000,
      emptyOutDir: !mill,
      rollupOptions: { input: mill ? 'mill.html' : 'index.html' },
    },
  };
});
