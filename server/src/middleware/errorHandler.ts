import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { log } from "../services/logger.js";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // Client mistakes rejected by middleware before any route runs — body-parser's malformed JSON
  // (400) / oversized body (413), both http-errors with `expose`, and multer's upload limits —
  // are the caller's fault, not a server fault to log as a 500 with a stack trace.
  if (err instanceof multer.MulterError) {
    res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.message });
    return;
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500 && (err as { expose?: unknown }).expose === true) {
    res.status(status).json({ error: (err as Error).message });
    return;
  }
  // Every other route's unhandled exception ends up here — routing it through the same log
  // service the rest of the app uses (rather than raw console.error) is what makes it show up
  // on the in-app Logs page instead of only being visible via `docker logs`.
  log.error(err instanceof Error ? err : String(err));
  res.status(500).json({ error: "Internal server error" });
}

export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
