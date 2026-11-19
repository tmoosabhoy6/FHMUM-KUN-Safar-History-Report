// Cloudflare Worker entry: /api/* goes to the read-only NKERP API (src/api.js);
// everything else is the app's page files, bundled into the Worker (src/site.js).
import { NKERPError, api, json } from "./api.js";
import { serveSite } from "./site.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url);
      } catch (err) {
        const message = err instanceof NKERPError ? err.message : `Unexpected error: ${err.message}`;
        return json({ error: message }, 502);
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    return serveSite(url);
  },
};
