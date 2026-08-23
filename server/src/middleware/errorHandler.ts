import type { NextFunction, Request, Response } from "express";
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
