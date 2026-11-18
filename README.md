# wayne-wen.dev

Personal website of Wayne Wen, live at https://wayne-wen.dev.

- `public/index.html`: the site, a single static page with an animated night-city scene drawn on a canvas.
- `src/index.ts`: a Cloudflare Worker that serves the page and runs `/live`, a Durable Object that lights one skyline window per visitor over WebSockets.
- `index.html` and `404.html` at the repository root redirect the old GitHub Pages address to the new domain.

- `lab/`: [Noise to Music](https://github.com/mr-neptune/noise-to-music) as a git submodule, served at `/lab/`. Each `wrangler deploy` or `wrangler dev` copies its `web/` folder to `public/lab/` (gitignored) during the build step.

- `layers/`: [Layers](https://github.com/mr-neptune/layers) as a git submodule. Its page is copied to `public/layers/` the same way. Song processing runs on Wayne's home server, behind a Cloudflare Tunnel:
  - The Worker forwards `/layers/demo*` (public, cached at the edge) and `/layers/api/*` to `LAYERS_ORIGIN`, adding the `LAYERS_KEY` secret.
  - `/layers/api/*` is guarded by a Cloudflare Access app (owner only), and the Worker verifies the Access token as well (`ACCESS_TEAM_DOMAIN`, `LAYERS_ACCESS_AUD`).

Clone with `git clone --recurse-submodules`, or run `git submodule update --init` in an existing clone. The build step also initializes the submodules if they are missing.

Deploy with `wrangler deploy`. Run locally with `wrangler dev`.

To ship a new version of the lab, update the submodule to the commit you want, commit the new pointer, then deploy:

```sh
git -C lab fetch && git -C lab checkout origin/main
git add lab && git commit -m "Update Noise to Music"
wrangler deploy
```
