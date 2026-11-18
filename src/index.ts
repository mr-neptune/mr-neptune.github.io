import { DurableObject } from "cloudflare:workers";

export interface Env {
  SKYLINE: DurableObjectNamespace<Skyline>;
  ASSETS: Fetcher;
  ALLOWED_ORIGINS: string;
  CANONICAL_HOST: string;
  LAYERS_ORIGIN?: string;
  LAYERS_KEY?: string;
  /** Cloudflare Access team domain, e.g. "wayne.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application Audience (AUD) tag of the Access app that guards /layers. */
  LAYERS_ACCESS_AUD?: string;
}

const MAX_VISITORS = 300;
const SLOT_COUNT = 600;

type Attachment = { slot: number };

/**
 * One shared skyline. Each open WebSocket is a visitor who owns one window
 * slot; every change is broadcast so all visitors see the same lit windows.
 * Uses the Hibernation API, so idle connections cost no duration.
 */
export class Skyline extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_VISITORS) {
      return new Response("Skyline is full", { status: 503 });
    }

    const taken = new Set(sockets.map((ws) => slotOf(ws)));
    let slot = Math.floor(Math.random() * SLOT_COUNT);
    while (taken.has(slot)) slot = (slot + 1) % SLOT_COUNT;

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ slot } satisfies Attachment);
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  // Clients never need to send anything; drop whatever arrives.
  async webSocketMessage(): Promise<void> {}

  // The runtime answers close frames itself (compatibility date >= 2026-04-07),
  // and calling close() with reserved codes such as 1005 would throw.
  async webSocketClose(ws: WebSocket): Promise<void> {
    this.broadcast(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcast(ws);
  }

  private broadcast(leaving?: WebSocket): void {
    const gone = leaving ? slotOf(leaving) : -2;
    const sockets = this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN && slotOf(ws) !== gone);
    console.log(`skyline broadcast: ${sockets.length} visitors${leaving ? `, slot ${gone} left` : ""}`);
    const slots = sockets.map((ws) => slotOf(ws));
    for (const ws of sockets) {
      try {
        ws.send(JSON.stringify({ type: "skyline", slots, you: slotOf(ws) }));
      } catch {
        // The socket is already closing; its close handler will rebroadcast.
      }
    }
  }
}

function slotOf(ws: WebSocket): number {
  return (ws.deserializeAttachment() as Attachment | null)?.slot ?? -1;
}

function originAllowed(origin: string | null, env: Env): boolean {
  if (!origin) return false;
  return env.ALLOWED_ORIGINS.split(",").some((allowed) => {
    allowed = allowed.trim();
    if (allowed.endsWith(":*")) return origin.startsWith(allowed.slice(0, -1));
    return origin === allowed;
  });
}

/**
 * Layers (github.com/mr-neptune/layers) processes songs on Wayne's home
 * server, reached through a Cloudflare Tunnel at LAYERS_ORIGIN. The page at
 * /layers/ is public and so is the example song (/layers/demo), cached at the
 * edge. The private API (/layers/api/*) sits behind Cloudflare Access, and
 * this Worker verifies the Access token as well before forwarding. Requests
 * to the origin carry a shared key so the tunnel can't be used directly.
 */
async function layers(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.LAYERS_ORIGIN || !env.LAYERS_KEY || !env.ACCESS_TEAM_DOMAIN || !env.LAYERS_ACCESS_AUD) {
    return Response.json({ error: "Layers is offline." }, { status: 503 });
  }
  const isDemo = url.pathname === "/layers/demo" || url.pathname.startsWith("/layers/demo/");
  if (isDemo) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    return forward(request, url, env, true);
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !(await accessTokenValid(token, env.ACCESS_TEAM_DOMAIN, env.LAYERS_ACCESS_AUD))) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  // The "Sign in" button links here; Access shows its login first.
  if (url.pathname === "/layers/api/login") return Response.redirect(`${url.origin}/layers/`, 302);
  return forward(request, url, env, false);
}

async function forward(request: Request, url: URL, env: Env, isPublic: boolean): Promise<Response> {
  const target = new URL(url.pathname.slice("/layers".length) + url.search, env.LAYERS_ORIGIN);
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "range", "accept", "accept-encoding"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-layers-key", env.LAYERS_KEY!);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      // The example song is the same for everyone: keep it at the edge so
      // visitors don't load the home server.
      cf: isPublic ? { cacheEverything: true, cacheTtl: 86400 } : { cacheTtl: 0 },
    });
    const out = new Response(upstream.body, upstream);
    // Private layer files may stay in the browser's cache, never in shared caches.
    if (!isPublic && !out.headers.get("cache-control")?.includes("private")) out.headers.set("cache-control", "private, no-store");
    return out;
  } catch {
    return Response.json({ error: "The Layers server isn't reachable right now." }, { status: 502 });
  }
}

let accessKeys: { at: number; keys: Map<string, CryptoKey> } | null = null;

async function accessKey(team: string, kid: string): Promise<CryptoKey | undefined> {
  if (!accessKeys || Date.now() - accessKeys.at > 3600_000 || !accessKeys.keys.has(kid)) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const map = new Map<string, CryptoKey>();
    for (const jwk of keys) {
      map.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    }
    accessKeys = { at: Date.now(), keys: map };
  }
  return accessKeys.keys.get(kid);
}

function b64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Verify a Cloudflare Access JWT: RS256 signature, issuer, audience and expiry. */
async function accessTokenValid(token: string, team: string, aud: string): Promise<boolean> {
  try {
    const [h, p, sig] = token.split(".");
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
    if (header.alg !== "RS256") return false;
    const key = await accessKey(team, header.kid);
    if (!key) return false;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    const now = Date.now() / 1000;
    const auds: string[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return ok && claims.iss === `https://${team}` && auds.includes(aud) && claims.exp > now && (claims.nbf ?? 0) <= now + 60;
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // www and plain HTTP redirect to https on the canonical domain.
    if (
      env.CANONICAL_HOST &&
      (url.hostname === `www.${env.CANONICAL_HOST}` || url.protocol === "http:")
    ) {
      url.hostname = env.CANONICAL_HOST;
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/live") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      if (!originAllowed(request.headers.get("Origin"), env)) {
        console.log(`refused origin=${request.headers.get("Origin")} host=${url.host}`);
        return new Response("Origin not allowed", { status: 403 });
      }
      return env.SKYLINE.getByName("main").fetch(request);
    }

    if (url.pathname.startsWith("/layers/api/") || url.pathname === "/layers/demo" || url.pathname.startsWith("/layers/demo/")) {
      return layers(request, url, env);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
