import "dotenv/config";
import { defineConfig, type Plugin } from "vite";

/** Dev middleware: same /api/approvals handler as production start.mjs. */
function approvalsApi(): Plugin {
  return {
    name: "brother-eli-approvals-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";
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
  plugins: [approvalsApi()],
  server: {
    port: 5175,
    // Hub page is served by a tiny middleware too
  },
  preview: { port: Number(process.env.PORT) || 4173, host: true, allowedHosts: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
