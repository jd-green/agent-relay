import { DurableObject } from "cloudflare:workers";
import protocol from "../protocol/PROTOCOL.md";
import page from "./ui/ledger.html";
export class BuildDO extends DurableObject<Env> {}
export class RelayDO extends DurableObject<Env> {}
export default {
  async fetch(req: Request) {
    const u = new URL(req.url);
    if (u.pathname === "/") return new Response(page, { headers: { "content-type": "text/html" } });
    return new Response(protocol);
  },
} satisfies ExportedHandler<Env>;
