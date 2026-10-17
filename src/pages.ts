/** Small Czech HTML pages for the receiving side — no framework, no assets. */
export function htmlPage(title: string, body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(
    `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex"><title>${esc(title)}</title>` +
      `<style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;box-sizing:border-box}main{max-width:28rem;text-align:center}h1{font-size:1.15rem;margin:0 0 .5rem}p{margin:.25rem 0;opacity:.8}</style>` +
      `</head><body><main>${body}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers } },
  );
}

export function errorPage(message: string, issuer?: string, status = 401): Response {
  const back = issuer ? `<p><a href="${esc(issuer.replace(/\/$/, ""))}/klicenka">Zpět do Klíčenky</a></p>` : "";
  return htmlPage("Přihlášení se nepodařilo", `<h1>Přihlášení se nepodařilo</h1><p>${esc(message)}</p>${back}`, status);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
