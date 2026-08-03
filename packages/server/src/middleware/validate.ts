import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny, z } from "zod";

type Source = "body" | "query" | "params";

/**
 * Validate a request part against a Zod schema. On success the parsed value is
 * stored on res.locals[<source>] for the handler to consume type-safely.
 */
export function validate<T extends ZodTypeAny>(schema: T, source: Source = "body") {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
      return;
    }
    res.locals[source] = result.data;
    next();
  };
}

/** Typed accessor for validated data placed on res.locals. */
export function validated<T extends ZodTypeAny>(res: Response, source: Source = "body"): z.infer<T> {
  return res.locals[source];
}
