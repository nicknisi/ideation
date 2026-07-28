import { defineConfig } from 'astro/config';
import tailwind from '@tailwindcss/vite';

// Deployed to Cloudflare from this directory: root `site`, build `pnpm build`,
// output `site/dist`. A static build needs no Cloudflare adapter.
//
// The marketing page lives in public/index.html and is served verbatim at `/`
// — it is a hand-written, self-contained page and moving it into Astro would
// mean porting its CSS and JS for no gain today. The guide is a real Astro
// route at /guide. Both ship from one deploy.
export default defineConfig({
  site: 'https://ideation.engineering',
  build: {
    // Match the marketing page's rule: no external requests, everything inline.
    inlineStylesheets: 'always',
    assets: '_assets',
  },
  vite: { plugins: [tailwind()] },
});
