import type { IncomingMessage, ServerResponse } from "node:http";
import { createLoginHandler, statusResponse, type LoginHandlerOptions } from "./handler.js";

/**
 * App Router:
 *   // app/klicenka/login/route.ts
 *   export const POST = klicenkaLogin({ ...config, findAccount, startSession });
 *   // app/klicenka/status/route.ts
 *   export const GET = klicenkaStatus("cookie");
 */
export function klicenkaLogin<User>(opts: LoginHandlerOptions<User>) {
  return createLoginHandler(opts);
}

export function klicenkaStatus(adapter: string, site?: { audience?: string; environment?: string }) {
  return async function GET() {
    return statusResponse(adapter, site);
  };
}

type PagesRequest = IncomingMessage & { body?: unknown };

/**
 * Pages Router: wraps a Request → Response handler as an API route.
 *   // pages/api/klicenka/login.ts
 *   export default toPagesHandler(klicenkaLogin({...}));
 * and in next.config: rewrites: [{ source: "/klicenka/:path*", destination: "/api/klicenka/:path*" }]
 */
export function toPagesHandler(handler: (req: Request) => Promise<Response>) {
  return async function pagesHandler(req: PagesRequest, res: ServerResponse) {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "https";
    const url = `${proto}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (typeof v === "string") headers.set(k, v);
    }
    let body: string | undefined;
    if (req.method === "POST") {
      if (typeof req.body === "string") body = req.body;
      else if (req.body && typeof req.body === "object") {
        body = new URLSearchParams(req.body as Record<string, string>).toString();
        headers.set("content-type", "application/x-www-form-urlencoded");
      } else {
        body = await new Promise<string>((resolve) => {
          let data = "";
          req.on("data", (c) => (data += c));
          req.on("end", () => resolve(data));
        });
      }
    }
    const response = await handler(new Request(url, { method: req.method, headers, body }));
    res.statusCode = response.status;
    const cookies = response.headers.getSetCookie();
    response.headers.forEach((value, key) => { if (key.toLowerCase() !== "set-cookie") res.setHeader(key, value); });
    if (cookies.length) res.setHeader("Set-Cookie", cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

export { statusResponse, redirectWithCookie } from "./handler.js";
