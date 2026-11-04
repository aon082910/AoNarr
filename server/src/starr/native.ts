import http from "node:http";
import type { Application } from "express";
import { HttpError } from "../middleware/errorHandler.js";
import { getSetting } from "../services/settingsStore.js";

/**
 * The Starr surface answers reads from the database and does its writes through AoNarr's own routes (the add, edit, delete,
 * search and indexer routes carry rules that must not be written twice). The app is called in process: a listener on a
 * loopback port of its own, opened on the first write and never kept the process alive, authenticated with the instance
 * key like any script of the admin's. The MCP server does the same over the configured port, which a test does not have.
 */
const listeners = new WeakMap<object, Promise<number>>();

function loopbackPort(app: Application): Promise<number> {
  let pending = listeners.get(app);
  if (!pending) {
    pending = new Promise<number>((resolve, reject) => {
      const server = http.createServer(app);
      server.once("error", (err) => {
        // Not kept: the next call tries to listen again.
        listeners.delete(app);
        reject(err);
      });
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        resolve((server.address() as { port: number }).port);
      });
    });
    listeners.set(app, pending);
  }
  return pending;
}

export interface NativeResult<T = any> {
  status: number;
  body: T;
}

/** Calls an /api route of this app. Any answer outside 2xx is raised as an HttpError carrying the route's own message. */
export async function callNative<T = any>(app: Application, method: string, path: string, body?: unknown): Promise<NativeResult<T>> {
  const port = await loopbackPort(app);
  const key = getSetting("apiKey");
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  // node:http, not fetch: a test (or an embedding) that replaces the global fetch must not break the app's own calls.
  const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}), ...(key ? { "X-Api-Key": key } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 500, text: Buffer.concat(chunks).toString("utf-8") }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (status < 200 || status >= 300) {
    const message = typeof parsed === "object" && parsed && typeof parsed.error === "string" ? parsed.error : `AoNarr answered ${status}`;
    throw Object.assign(new HttpError(status, message), { body: parsed });
  }
  return { status, body: parsed as T };
}
