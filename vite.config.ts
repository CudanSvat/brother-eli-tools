import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/** Dev middleware: tools hub + same /api/approvals handler as production. */
function toolsDevServer(): Plugin {
  return {
    name: "brother-eli-tools-dev",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";
        const pathname = url.split("?")[0];

        if (pathname === "/tools" || pathname === "/tools/") {
          const hub = path.join(rootDir, "server", "tools-hub.html");
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(fs.readFileSync(hub));
          return;
        }

        if (
          !url.startsWith("/api/approvals") &&
          !url.startsWith("/tools/revoke/api/approvals")
        ) {
          next();
          return;
        }
        try {
          const { handleApprovalsRequest } = await import("./server/approvals.mjs");
          await handleApprovalsRequest(req, res);
        } catch (error) {
          console.error("approvals api:", error);
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Approvals scan failed" }));
        }
      });
    },
  };
}

/** Base path for brothereli.com/tools/revoke */
export default defineConfig({
  base: "/tools/revoke/",
  plugins: [toolsDevServer()],
  server: { port: 5175 },
  preview: { port: Number(process.env.PORT) || 4173, host: true, allowedHosts: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
