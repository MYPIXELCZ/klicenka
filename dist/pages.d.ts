/** Small Czech HTML pages for the receiving side — no framework, no assets. */
export declare function htmlPage(title: string, body: string, status?: number, headers?: Record<string, string>): Response;
export declare function errorPage(message: string, issuer?: string, status?: number): Response;
export declare function esc(s: string): string;
