import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../logger.js";

/** Thrown by services/handlers to signal a specific HTTP status. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: "Not found" });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: err.flatten() });
    return;
  }
  // body-parser's request-entity-too-large error (express.json's byte limit) —
  // surface the precise 413 rather than folding it into a generic 500 (Phase 6).
  const be = err as { type?: string; status?: number; statusCode?: number };
  if (be?.type === "entity.too.large" || be?.status === 413 || be?.statusCode === 413) {
    res.status(413).json({ error: "Request body too large" });
    return;
  }
  // Malformed JSON body — a client error, not a server fault.
  if (be?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Malformed request body" });
    return;
  }
  // Unknown/unexpected: log server-side (redacted), return a generic message.
  // Never include the error's message/stack in the response — only a fixed string.
  logger.error("Unhandled error", { path: req.path, method: req.method, message: (err as Error)?.message });
  res.status(500).json({ error: "Internal server error" });
}

/** Wrap an async handler so rejected promises reach the error handler. */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
