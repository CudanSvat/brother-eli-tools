/**
 * Production host for Railway — Brother Eli Tools hub + Revoke.
 *  - /tools/           → tools hub
 *  - /tools/revoke/    → revoke SPA (dist/)
 *  - /tools/revoke/api/approvals → scanner (STARKSCAN_API_KEY optional)
 */
import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApprovalsRequest } from "./server/approvals.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
const hubHtml = path.join(here, "server", "tools-hub.html");
const port = Number(process.env.PORT || 4173);
const BASE = "/tools/revoke";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
    });
  });
}

function serveRevokeSpa(res, relPath) {
  const filePath = path.normalize(path.join(dist, relPath));
  if (!filePath.startsWith(dist)) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(dist, "index.html"), (err2, html) => {
        if (err2) return send(res, 404, "Not found");
        send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
    });
  });
}

const server = http.createServer((req, res) => {
  const host = req.headers.host || "localhost";
  const u = new URL(req.url || "/", `http://${host}`);
  const pathName = u.pathname;

  // Approvals API (with or without tools prefix)
  if (
    pathName === "/api/approvals" ||
    pathName.startsWith("/api/approvals?") ||
    pathName === `${BASE}/api/approvals` ||
    pathName.startsWith(`${BASE}/api/approvals`)
  ) {
    void handleApprovalsRequest(req, res);
    return;
  }

  // Root → tools hub
  if (pathName === "/" || pathName === "") {
    res.writeHead(302, { Location: "/tools/" });
    res.end();
    return;
  }

  // Tools hub
  if (pathName === "/tools" || pathName === "/tools/") {
    serveFile(res, hubHtml);
    return;
  }

  // Revoke app under /tools/revoke
  if (pathName === BASE || pathName === `${BASE}/`) {
    serveRevokeSpa(res, "/index.html");
    return;
  }
  if (pathName.startsWith(`${BASE}/`)) {
    let rel = decodeURIComponent(pathName.slice(BASE.length));
    if (!rel || rel === "/") rel = "/index.html";
    serveRevokeSpa(res, rel);
    return;
  }

  send(res, 404, "Not found — try /tools/");
});

if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error(`Missing ${path.join(dist, "index.html")} — run npm run build first.`);
  process.exit(1);
}

server.listen(port, "0.0.0.0", () => {
  console.log(`Brother Eli Tools on http://0.0.0.0:${port}/tools/`);
  console.log(`Revoke at http://0.0.0.0:${port}/tools/revoke/`);
  if (!process.env.STARKSCAN_API_KEY) {
    console.warn("STARKSCAN_API_KEY not set — curated matrix only (add later in Railway).");
  }
});
