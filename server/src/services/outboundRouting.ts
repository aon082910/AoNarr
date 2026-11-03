import tls from "node:tls";
import { Agent, Dispatcher } from "undici";
import { SocksClient } from "socks";
import { isLocalAddress, matchesBypassFilter, type FilterEntry } from "./networkAddress.js";

export type CertificateMode = "enabled" | "local" | "disabled";

export interface RoutePolicy {
  hasProxy: boolean;
  bypassLocal: boolean;
  filter: FilterEntry[];
  certificates: CertificateMode;
}

/** What to do for one destination host: send it through the proxy or straight out, and whether to check its certificate. */
export function planRoute(host: string, policy: RoutePolicy): { viaProxy: boolean; verifyCertificate: boolean } {
  const local = isLocalAddress(host);
  const direct = (policy.bypassLocal && local) || matchesBypassFilter(host, policy.filter);
  const verifyCertificate = policy.certificates === "enabled" ? true : policy.certificates === "disabled" ? false : !local;
  return { viaProxy: policy.hasProxy && !direct, verifyCertificate };
}

/** The host name of a request's origin; empty when it cannot be read. */
export function hostOfOrigin(origin: string | URL | undefined): string {
  if (!origin) return "";
  try {
    return new URL(String(origin)).hostname;
  } catch {
    return "";
  }
}

/**
 * A dispatcher that hands each request to one of several undici agents. `choose` decides per
 * request from the destination host, so one installed dispatcher can send some hosts through a
 * proxy and others straight out.
 */
export class RoutingDispatcher extends Dispatcher {
  constructor(
    private readonly choose: (host: string) => Dispatcher,
    private readonly members: () => Dispatcher[]
  ) {
    super();
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    return this.choose(hostOfOrigin(options.origin)).dispatch(options, handler);
  }

  close(): Promise<void>;
  close(callback: () => void): void;
  close(callback?: () => void): Promise<void> | void {
    const finished = Promise.all(this.members().map((member) => member.close())).then(() => undefined);
    if (!callback) return finished;
    finished.then(callback, callback);
  }

  destroy(errOrCallback?: any, callback?: any): any {
    const done = typeof errOrCallback === "function" ? errOrCallback : callback;
    const finished = Promise.all(this.members().map((member) => member.destroy())).then(() => undefined);
    if (!done) return finished;
    finished.then(() => done(), () => done());
  }
}

/** An agent whose connections are opened through a SOCKS4 or SOCKS5 server. */
export function socksTunnelAgent(server: URL, verifyCertificates: boolean): Agent {
  const port = Number(server.port) || 1080;
  const userId = server.username ? decodeURIComponent(server.username) : undefined;
  const password = server.password ? decodeURIComponent(server.password) : undefined;
  const type = server.protocol === "socks4:" || server.protocol === "socks4a:" ? 4 : 5;

  return new Agent({
    connect: (opts: any, callback: any) => {
      const secure = opts.protocol === "https:";
      SocksClient.createConnection({
        proxy: { host: server.hostname, port, type, userId, password },
        command: "connect",
        destination: { host: opts.hostname, port: Number(opts.port) || (secure ? 443 : 80) },
      })
        .then(({ socket }) => {
          if (!secure) {
            callback(null, socket);
            return;
          }
          // A connect function owns the handshake, so the tunnelled socket is upgraded here.
          const upgraded = tls.connect({
            socket,
            servername: opts.servername || opts.hostname,
            rejectUnauthorized: verifyCertificates,
            ALPNProtocols: ["http/1.1"],
          });
          upgraded.once("secureConnect", () => callback(null, upgraded));
          upgraded.once("error", (err) => callback(err, null));
        })
        .catch((err) => callback(err, null));
    },
  });
}
