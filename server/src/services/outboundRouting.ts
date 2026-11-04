import dns from "node:dns";
import net from "node:net";
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
export function planRoute(host: string, policy: RoutePolicy): { viaProxy: boolean; verifyCertificate: boolean; guardName: boolean } {
  const local = isLocalAddress(host);
  const isName = net.isIP(host.replace(/^\[|\]$/g, "")) === 0;
  const listed = matchesBypassFilter(host, policy.filter);
  const direct = (policy.bypassLocal && local) || listed;
  const viaProxy = policy.hasProxy && !direct;
  let verifyCertificate = policy.certificates === "enabled" ? true : policy.certificates === "disabled" ? false : !local;
  // A name sent through the proxy is looked up by the proxy, not here: nothing can show that it is really a local host, so the
  // "disabled for local addresses" rule (which rests on the host being local) does not skip its certificate check.
  if (viaProxy && isName && policy.certificates === "local") verifyCertificate = true;
  // "Disabled for local addresses" skips the certificate check because the host is local. For an IP address the text says
  // it all; for a NAME (a short name, .lan, .local) only the lookup does, and a name that resolves to a public address
  // must not get the check skipped: the connection is refused instead (see guardedLocalLookup). The same lookup guard applies
  // whatever the certificate setting when a proxy is in use and the name goes out directly only because it looks local: a search
  // domain or a hijacked DNS answer must not turn it into a request that leaves from the real address.
  const guardName = local && isName && !viaProxy && (policy.certificates === "local" || (policy.hasProxy && !listed));
  return { viaProxy, verifyCertificate, guardName };
}

/**
 * A DNS lookup for a host name that was treated as local: it fails when the name resolves to an address that is not
 * local, so a name under a LAN-looking suffix (or a short name completed by a search domain) cannot lead a connection
 * with no certificate check to a public server.
 */
export function guardedLocalLookup(hostname: string, options: any, callback: (...args: any[]) => void): void {
  const wantsAll = !!options?.all;
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const all = addresses as unknown as dns.LookupAddress[];
    // A name with a private address and also a public one (a router that adds a global IPv6 address, a split-horizon name) is
    // reached on the private one; only a name that has no local address at all is refused.
    const list = all.filter((entry) => isLocalAddress(entry.address));
    if (list.length === 0) {
      return callback(
        new Error(
          `"${hostname}" is treated as a local host, but it resolves to ${all[0]?.address ?? "nothing"}, which is not a local address: the connection is refused (use the "Enabled" certificate setting, list the name under the proxy bypass list, or fix the name)`
        )
      );
    }
    if (wantsAll) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
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
  /** Requests this dispatcher has been given: a self-check uses it to see that fetch really goes through here. */
  dispatched = 0;

  constructor(
    private readonly choose: (host: string) => Dispatcher,
    private readonly members: () => Dispatcher[]
  ) {
    super();
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    this.dispatched++;
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

/**
 * A dispatcher that answers every request with an error: what a request that needs the outbound proxy gets while the proxy
 * setting is there but unusable (an address that does not parse, a value that could not be decrypted). Going out directly
 * instead would send the request, and the admin's real address, where the proxy was meant to hide it.
 */
export class RefusingDispatcher extends Dispatcher {
  constructor(
    private readonly reason: string,
    private readonly onRefuse?: () => void
  ) {
    super();
  }

  dispatch(_options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    const error = Object.assign(new Error(this.reason), { code: "AONARR_PROXY_UNUSABLE" });
    queueMicrotask(() => {
      try {
        this.onRefuse?.();
        const target = handler as unknown as { onError?: (err: Error) => void };
        target.onError?.(error);
      } catch {
        // a handler that throws while being told about the error has nothing more to be told
      }
    });
    return true;
  }

  close(): Promise<void>;
  close(callback: () => void): void;
  close(callback?: () => void): Promise<void> | void {
    if (!callback) return Promise.resolve();
    callback();
  }

  destroy(errOrCallback?: any, callback?: any): any {
    const done = typeof errOrCallback === "function" ? errOrCallback : callback;
    if (!done) return Promise.resolve();
    done();
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
