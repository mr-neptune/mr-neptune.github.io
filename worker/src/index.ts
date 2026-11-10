import { DurableObject } from "cloudflare:workers";

export interface Env {
  SKYLINE: DurableObjectNamespace<Skyline>;
  ALLOWED_ORIGINS: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/live") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      if (!originAllowed(request.headers.get("Origin"), env)) {
        return new Response("Origin not allowed", { status: 403 });
      }
      return env.SKYLINE.getByName("main").fetch(request);
    }

    if (url.pathname === "/") {
      return new Response("Backend for https://mr-neptune.github.io\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
