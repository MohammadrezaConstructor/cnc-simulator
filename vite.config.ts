import { defineConfig, type Plugin } from 'vite';

// Each app builds to its own self-contained HTML file that works offline (file://):
//   vite build             → dist/index.html  (lathe)
//   vite build --mode mill → dist/mill.html   (milling)

/** Inline the bundled JS and CSS into the HTML page (one file per app, no external assets). */
function singleFile(): Plugin {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    name: 'single-file',
    enforce: 'post',
    config: () => ({
      base: './',
      build: {
        assetsInlineLimit: () => true,
        assetsDir: '',
        cssCodeSplit: false,
        rollupOptions: { output: { codeSplitting: false } },
      },
    }),
    generateBundle(_options, bundle) {
      for (const page of Object.values(bundle)) {
        if (page.type !== 'asset' || !page.fileName.endsWith('.html')) continue;
        let html = String(page.source);
        for (const [name, f] of Object.entries(bundle)) {
          if (f.type === 'chunk' && /\.[mc]?js$/.test(name)) {
            const re = new RegExp(`<script([^>]*?) src="(?:[^"]*?/)?${esc(f.fileName)}"([^>]*)></script>`);
            // "</script" or "<!--" inside the code would end the inline script early
            const code = f.code.replace(/"?__VITE_PRELOAD__"?/g, 'void 0').replace(/<(\/script>|!--)/g, '\\x3C$1').trim();
            html = html.replace(re, (_m, a: string, b: string) => `<script${a}${b}>${code}</script>`);
            delete bundle[name];
          } else if (f.type === 'asset' && name.endsWith('.css')) {
            const re = new RegExp(`<link([^>]*?) href="(?:[^"]*?/)?${esc(f.fileName)}"([^>]*)>`);
            const css = String(f.source).replace('@charset "UTF-8";', '').trim();
            html = html.replace(re, (_m, a: string, b: string) => `<style${a}${b}>${css}</style>`);
            delete bundle[name];
          }
        }
        page.source = html;
      }
      const left = Object.keys(bundle).filter((n) => !n.endsWith('.html'));
      if (left.length) this.warn(`not inlined: ${left.join(', ')}`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const mill = mode === 'mill';
  return {
    plugins: [singleFile()],
    build: {
      chunkSizeWarningLimit: 4000,
      emptyOutDir: !mill,
      rollupOptions: { input: mill ? 'mill.html' : 'index.html' },
    },
  };
});
