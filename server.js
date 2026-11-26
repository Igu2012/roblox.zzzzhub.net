"use strict";
const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");
const httpProxy = require("http-proxy");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const { PORT, HOST, BASE, TARGET_ORIGIN, PLAY_ORIGIN, PROXY_PREFIX } = require("./lib/config");
const { rewriteRequestHeaders, rewriteResponseHeaders } = require("./lib/headers");
const { rewriteHtml, rewriteCss, rewriteJs } = require("./lib/rewriter");

const proxy = httpProxy.createProxyServer({ selfHandleResponse: true, changeOrigin: true, ws: true, xfwd: false });

function parseTarget(raw) {
  const localizedLegacy = raw.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?)\/x\/(https?:\/\/.*)$/i);
  if (localizedLegacy) raw = PROXY_PREFIX + localizedLegacy[1];
  if (raw.startsWith(PROXY_PREFIX)) {
    const encodedTarget = raw.slice(PROXY_PREFIX.length);
    const target = new URL(decodeURIComponent(encodedTarget));
    if (target.origin === BASE || /(^|\.)roblox-browser-proxy\.onrender\.com$/i.test(target.hostname)) {
      return new URL(target.pathname + target.search, TARGET_ORIGIN);
    }
    return target;
  }
  const pathname = (raw || "/").split("?")[0];
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/start(?:\/|$)/i.test(pathname)) {
    return new URL(raw || "/", PLAY_ORIGIN);
  }
  return new URL(raw || "/", TARGET_ORIGIN);
}

function applyForge(proxyReq, req) {
  const forged = rewriteRequestHeaders(req.headers, req.__targetOrigin || "");
  for (const k of Object.keys(proxyReq.getHeaders())) if (!(k in forged)) proxyReq.removeHeader(k);
  for (const [k, v] of Object.entries(forged)) if (v != null) proxyReq.setHeader(k, v);
}
proxy.on("proxyReq", applyForge);

function decodeBody(body, encoding) {
  const enc = (encoding || "").toLowerCase().trim();
  if (enc === "gzip") return zlib.gunzipSync(body);
  if (enc === "deflate") return zlib.inflateSync(body);
  if (enc === "br") return zlib.brotliDecompressSync(body);
  return body;
}

proxy.on("proxyRes", (proxyRes, req, res) => {
  const targetUrl = req.__targetHref || "";
  const origin = req.__targetOrigin || "";
  const ct = (proxyRes.headers["content-type"] || "").toLowerCase();
  const chunks = [];
  proxyRes.on("data", c => chunks.push(c));
  proxyRes.on("error", () => {
    if (!res.headersSent) { res.writeHead(502, {"content-type":"text/plain"}); res.end("upstream stream error"); }
  });
  proxyRes.on("end", () => {
    if (res.headersSent) return;
    let body = Buffer.concat(chunks);
    if (proxyRes.headers["content-encoding"]) {
      try { body = decodeBody(body, proxyRes.headers["content-encoding"]); } catch {}
    }
    let outBody = body;
    try {
      if (ct.includes("text/html")) outBody = Buffer.from(rewriteHtml(body.toString("utf8"), origin, targetUrl), "utf8");
      else if (ct.includes("text/css")) outBody = Buffer.from(rewriteCss(body.toString("utf8"), origin), "utf8");
      else if (ct.includes("javascript") || ct.includes("ecmascript")) outBody = Buffer.from(rewriteJs(body.toString("utf8"), origin), "utf8");
    } catch (e) { console.error("rewrite failed:", e.message); outBody = body; }
    const headers = rewriteResponseHeaders(proxyRes.headers, targetUrl);
    headers["content-length"] = Buffer.byteLength(outBody);
    res.writeHead(proxyRes.statusCode, headers);
    res.end(outBody);
  });
});

proxy.on("error", (err, req, res) => {
  if (res && typeof res.writeHead === "function" && !res.headersSent) {
    res.writeHead(502, {"content-type":"text/plain"}); res.end("proxy error: " + err.message);
  } else if (res && typeof res.destroy === "function") {
    res.destroy();
  }
});

const handler = (req, res) => {
  if (req.url === "/index.html") req.url = "/";
  if (req.url.startsWith("/")) {
    let target;
    try { target = parseTarget(req.url); } catch {
      res.writeHead(400, {"content-type":"text/plain"}); res.end("bad target: " + req.url); return;
    }
    req.__targetHref = target.href;
    req.__targetOrigin = target.origin;
    const orig = req.url;
    req.url = target.pathname + target.search;
    proxy.web(req, res, { target: target.origin, changeOrigin: true, prependPath: false }, (err) => {
      req.url = orig;
      if (!res.headersSent) { res.writeHead(502, {"content-type":"text/plain"}); res.end("proxy failed: " + err.message); }
    });
    return;
  }
  res.writeHead(404, {"content-type":"text/plain"}); res.end("not found: " + req.url);
};

const server = http.createServer(handler);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url || !req.url.startsWith(PROXY_PREFIX)) { socket.destroy(); return; }
  let target;
  try { target = parseTarget(req.url); } catch { socket.destroy(); return; }
  if (!/^wss?:$/i.test(target.protocol)) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (client) => {
    const upstreamOrigin = target.origin.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    const headers = rewriteRequestHeaders(req.headers, upstreamOrigin);
    for (const name of ["host", "connection", "upgrade", "content-length", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]) delete headers[name];
    headers.origin = upstreamOrigin;
    const protocols = req.headers["sec-websocket-protocol"]
      ? req.headers["sec-websocket-protocol"].split(",").map(value => value.trim()).filter(Boolean)
      : undefined;
    const upstream = new WebSocket(target.href, protocols, { headers });
    const pending = [];
    let upstreamReady = false;
    const closeBoth = () => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    };
    client.on("message", (data, isBinary) => {
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else pending.push([data, isBinary]);
    });
    client.on("close", () => { if (upstream.readyState === WebSocket.OPEN) upstream.close(); });
    client.on("error", closeBoth);
    upstream.on("open", () => {
      upstreamReady = true;
      for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary });
      pending.length = 0;
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on("close", () => { if (client.readyState === WebSocket.OPEN) client.close(); });
    upstream.on("error", closeBoth);
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log("roblox.zzzzhub.net proxy");
    console.log("  listening: http://" + HOST + ":" + PORT);
    console.log("  open:      http://localhost:" + PORT + "/");
  });
}

module.exports = { handler, server };
