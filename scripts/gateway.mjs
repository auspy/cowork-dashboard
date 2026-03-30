#!/usr/bin/env node
/**
 * Gateway proxy — single port, path-based routing to multiple local services.
 * Run: node scripts/gateway.mjs
 * Then point ngrok at this port: ngrok http 9000 --basic-auth=ssb:passwordisawesome
 *
 * Routes:
 *   /paperclip/*  → localhost:3100 (Cowork Dashboard)
 *   /*            → localhost:8042 (Research Data API) — default, backward compatible
 */

import http from "node:http";

const ROUTES = [
  { prefix: "/paperclip", target: "http://127.0.0.1:3100", strip: true },
];
const DEFAULT_TARGET = "http://127.0.0.1:8042";
const PORT = 9000;

function proxy(req, res, targetBase) {
  const url = new URL(targetBase);
  const opts = {
    hostname: url.hostname,
    port: url.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${url.hostname}:${url.port}` },
  };

  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Gateway", target: targetBase, message: err.message }));
  });

  req.pipe(proxyReq, { end: true });
}

const server = http.createServer((req, res) => {
  for (const route of ROUTES) {
    if (req.url.startsWith(route.prefix)) {
      if (route.strip) {
        req.url = req.url.slice(route.prefix.length) || "/";
      }
      return proxy(req, res, route.target);
    }
  }
  proxy(req, res, DEFAULT_TARGET);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Gateway listening on http://127.0.0.1:${PORT}`);
  console.log(`  /paperclip/*  → http://127.0.0.1:3100 (Cowork Dashboard)`);
  console.log(`  /*            → http://127.0.0.1:8042 (Research Data API)`);
  console.log(`\nPoint ngrok here: ngrok http ${PORT} --basic-auth=ssb:passwordisawesome`);
});
