import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const changelogRouter = Router();

changelogRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const changelogPath = path.join(__dirname, "..", "..", "CHANGELOG.md");
    let markdown: string;
    try {
      markdown = fs.readFileSync(changelogPath, "utf-8");
    } catch {
      markdown = "# Changelog\n\nNo changelog available.";
    }
    res.json({ markdown });
  })
);
