import "./utils/bigint.js"; // teach JSON to serialize BigInt (must be first)
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { attachSession } from "./auth/middleware.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { apiRouter } from "./routes/index.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);

  // Security headers. CSP is tuned for a same-origin SPA served by this process.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: "6mb" }));
  app.use(attachSession);

  // API.
  app.use("/api", apiLimiter, apiRouter);
  app.use("/api", notFound); // JSON 404 for unknown API routes

  // Static frontend + SPA fallback (unknown routes return index.html).
  const publicDir = resolve(import.meta.dirname, "../public");
  const indexHtml = resolve(publicDir, "index.html");
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: false, maxAge: "1h" }));
    app.get("*", (_req, res, next) => {
      if (existsSync(indexHtml)) res.sendFile(indexHtml);
      else next();
    });
  }

  app.use(errorHandler);
  return app;
}
