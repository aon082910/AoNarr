import type { NextFunction, Request, Response } from "express";
import { emitHealthChange } from "../services/healthEvents.js";

const CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * In front of the routers whose data the health checks read (root folders, indexers, download clients, import lists,
 * remote path mappings, settings): once such a change has been saved the kept health report is dropped, so the System
 * page and the Dashboard show the effect now and not at the next ten-minute refresh.
 */
export function healthStaleOnChange(req: Request, res: Response, next: NextFunction): void {
  if (CHANGING.has(req.method)) {
    res.once("finish", () => {
      if (res.statusCode < 400) emitHealthChange();
    });
  }
  next();
}
