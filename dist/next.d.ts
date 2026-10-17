import type { IncomingMessage, ServerResponse } from "node:http";
import { type LoginHandlerOptions } from "./handler.js";
/**
 * App Router:
 *   // app/klicenka/login/route.ts
 *   export const POST = klicenkaLogin({ ...config, findAccount, startSession });
 *   // app/klicenka/status/route.ts
 *   export const GET = klicenkaStatus("cookie");
 */
export declare function klicenkaLogin<User>(opts: LoginHandlerOptions<User>): (request: Request) => Promise<Response>;
export declare function klicenkaStatus(adapter: string, site?: {
    audience?: string;
    environment?: string;
}): () => Promise<Response>;
type PagesRequest = IncomingMessage & {
    body?: unknown;
};
/**
 * Pages Router: wraps a Request → Response handler as an API route.
 *   // pages/api/klicenka/login.ts
 *   export default toPagesHandler(klicenkaLogin({...}));
 * and in next.config: rewrites: [{ source: "/klicenka/:path*", destination: "/api/klicenka/:path*" }]
 */
export declare function toPagesHandler(handler: (req: Request) => Promise<Response>): (req: PagesRequest, res: ServerResponse) => Promise<void>;
export { statusResponse, redirectWithCookie } from "./handler.js";
