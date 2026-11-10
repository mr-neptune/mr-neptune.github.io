# wayne-wen.dev

Personal website of Wayne Wen, live at https://wayne-wen.dev.

- `public/index.html`: the site, a single static page with an animated night-city scene drawn on a canvas.
- `src/index.ts`: a Cloudflare Worker that serves the page and runs `/live`, a Durable Object that lights one skyline window per visitor over WebSockets.
- `index.html` and `404.html` at the repository root redirect the old GitHub Pages address to the new domain.

Deploy with `wrangler deploy`. Run locally with `wrangler dev`.
