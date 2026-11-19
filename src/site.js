// Serves the app's page files, embedded at build time by scripts/embed-site.js.
import { FILES } from "./generated/site-files.js";

export function serveSite(url) {
  const file = FILES[url.pathname];
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(file[0], {
    headers: {
      "Content-Type": file[1],
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    },
  });
}
