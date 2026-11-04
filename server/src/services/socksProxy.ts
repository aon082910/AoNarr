import http from "node:http";
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { getSetting, isSettingUndecryptable } from "./settingsStore.js";
import { log } from "./logger.js";
import { isLocalAddress, parseBypassFilter, proxyUrlProblem, redactProxyUrl } from "./networkAddress.js";
import { guardedLocalLookup, planRoute, RefusingDispatcher, RoutingDispatcher, socksTunnelAgent, type CertificateMode, type RoutePolicy } from "./outboundRouting.js";

const defaultDispatcher = getGlobalDispatcher();
let appliedSignature: string | null = null;
let installed: RoutingDispatcher | null = null;
/** Why the proxy setting cannot be used while one is set, or null: while it is set, requests that need the proxy are refused. */
let blockedReason: string | null = null;

/** The reason the configured outbound proxy is unusable (requests that need it fail), or null when it is fine or not set. */
export function proxyBlockedReason(): string | null {
  return blockedReason;
}

/** From the `tlsRejectUnauthorized` setting: "1" always check, "local" skip for local hosts, "0" never check. */
export function certificateMode(): CertificateMode {
  const value = getSetting("tlsRejectUnauthorized");
  return value === "0" ? "disabled" : value === "local" ? "local" : "enabled";
}

/** The proxy URL as a URL, or null (with an error in the log, credentials left out) when it cannot be used. */
function parseProxyUrl(url: string): URL | null {
  const problem = proxyUrlProblem(url);
  if (problem) {
    log.error(`[socksProxy] the proxy URL "${redactProxyUrl(url)}" ${problem}: requests that need the proxy are refused until it is fixed`);
    return null;
  }
  return new URL(url.trim());
}

/**
 * A request can be between two redirect hops when the settings change, and fetch keeps the
 * dispatcher it started with for the later hops, so the old one is closed after a delay, not at once.
 */
const CLOSE_OLD_DISPATCHER_AFTER_MS = 30_000;

let lastRefusalLogAt = 0;

/** Callers log only "fetch failed"; this says why, at most once a minute. */
function noteRefusal(): void {
  const now = Date.now();
  if (now - lastRefusalLogAt < 60_000) return;
  lastRefusalLogAt = now;
  log.warn(`[socksProxy] an outbound request was refused: ${blockedReason ?? "the outbound proxy is unusable"}`);
}

function closeLater(old: RoutingDispatcher | null): void {
  if (!old) return;
  setTimeout(() => old.close().catch(() => {}), CLOSE_OLD_DISPATCHER_AFTER_MS).unref();
}

/**
 * Installs the dispatcher behind every outbound fetch() (indexers, metadata providers, download
 * clients, webhooks). Settings used:
 *
 * - `socks5ProxyUrl`: a SOCKS4/5 or HTTP(S) proxy for outbound traffic. Local hosts go straight out
 *   unless `proxyBypassLocal` is "0"; `proxyBypassFilter` adds hosts, wildcards and CIDR blocks.
 * - `tlsRejectUnauthorized`: "1" checks server certificates, "local" skips the check for local
 *   hosts only, "0" skips it for all hosts.
 *
 * Node's fetch has no proxy support, so a global undici dispatcher is installed instead.
 */
export function applySocksProxySetting(): void {
  const url = getSetting("socks5ProxyUrl");
  const mode = certificateMode();
  const bypassLocal = getSetting("proxyBypassLocal") !== "0";
  const filterText = (getSetting("proxyBypassFilter") ?? "").trim();
  const undecryptableProxy = !url && isSettingUndecryptable("socks5ProxyUrl");
  // The undecryptable flag is part of the signature: clearing an undecryptable value leaves the text empty but must lift the block.
  const signature = `${url ?? ""}|${undecryptableProxy}|${mode}|${bypassLocal}|${filterText}`;
  if (signature === appliedSignature) return;
  appliedSignature = signature;

  // A proxy that is set but cannot be used (a value that does not parse, one that could not be decrypted) fails closed:
  // requests that would have used it are refused, because sending them out directly would show the address the proxy was
  // there to hide. Local hosts and the bypass list still go direct. Clearing the setting is how to run without a proxy.
  const proxy = url ? parseProxyUrl(url) : null;
  blockedReason = url && !proxy
    ? `the proxy address ${proxyUrlProblem(url) ?? "cannot be used"}`
    : undecryptableProxy
      ? "the stored proxy address could not be decrypted (the encryption key does not match this database)"
      : null;
  if (undecryptableProxy) log.error("[socksProxy] the stored proxy address could not be decrypted: requests that need the proxy are refused until it is entered again");

  if (!proxy && !blockedReason && mode === "enabled") {
    setGlobalDispatcher(defaultDispatcher);
    closeLater(installed);
    installed = null;
    return;
  }

  // Whether to check the certificate of an https proxy itself: the setting decides, by the proxy's own address.
  const proxyVerify = mode === "disabled" ? false : mode === "local" ? !(proxy && isLocalAddress(proxy.hostname)) : true;

  const filter = parseBypassFilter(filterText, (item) =>
    log.warn(`[socksProxy] ignoring bypass list entry "${item}": only host names, wildcards, IPv4 and IPv6 addresses and ranges (a.b.c.d/n, fd00::/8) are understood`)
  );
  const agents = new Map<string, Dispatcher>();
  const agentFor = (viaProxy: boolean, verify: boolean, guardName = false): Dispatcher => {
    const key = `${viaProxy ? "proxy" : "direct"}|${verify}|${guardName ? "guarded" : "plain"}`;
    let agent = agents.get(key);
    if (!agent) {
      if (viaProxy && proxy) {
        const web = proxy.protocol === "http:" || proxy.protocol === "https:";
        agent = web
          ? new ProxyAgent({ uri: proxy.href, requestTls: { rejectUnauthorized: verify }, proxyTls: { rejectUnauthorized: proxyVerify } })
          : socksTunnelAgent(proxy, verify);
      } else if (viaProxy) {
        agent = new RefusingDispatcher(`Outbound request refused: ${blockedReason ?? "the outbound proxy is unusable"}. Fix or clear the proxy setting.`, noteRefusal);
      } else {
        agent = new Agent({ connect: { rejectUnauthorized: verify, ...(guardName ? { lookup: guardedLocalLookup } : {}) } });
      }
      agents.set(key, agent);
    }
    return agent;
  };

  const policy: RoutePolicy = { hasProxy: proxy != null || blockedReason != null, bypassLocal, filter, certificates: mode };
  const router = new RoutingDispatcher(
    (host) => {
      const plan = planRoute(host, policy);
      return agentFor(plan.viaProxy, plan.verifyCertificate, plan.guardName);
    },
    () => [...agents.values()]
  );

  const previous = installed;
  setGlobalDispatcher(router);
  installed = router;
  closeLater(previous);

  if (mode === "disabled") log.warn("[network] TLS certificate validation is DISABLED for all outbound requests");
  if (mode === "local") log.warn("[network] TLS certificate validation is disabled for local addresses");
  if (proxy) {
    const port = proxy.port || (proxy.protocol.startsWith("socks") ? "1080" : "80");
    log.info(`[socksProxy] outbound requests now routed through ${proxy.protocol}//${proxy.hostname}:${port}${bypassLocal ? " (local addresses go direct)" : ""}`);
  }
}

/** The outcome of the last verifyOutboundDispatcher run; null before it ran. */
let dispatcherCheck: { ok: boolean; at: string } | null = null;

export function outboundDispatcherCheck(): { ok: boolean; at: string } | null {
  return dispatcherCheck;
}

/**
 * Checks that fetch() really goes through the dispatcher installed above. It does on the Node this was written for; a Node
 * whose built-in fetch carries a different undici ignores a dispatcher set by the undici package, and then the proxy, the
 * bypass list and the certificate setting would silently stop applying. One request to a throwaway local server is sent
 * and the dispatcher's own counter is read. Nothing is checked (and nothing reported) while no dispatcher is installed.
 */
export async function verifyOutboundDispatcher(): Promise<boolean> {
  const router = installed;
  if (!router) {
    dispatcherCheck = null;
    return true;
  }
  const server = http.createServer((_req, res) => res.end("ok"));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as { port: number }).port;
    const before = router.dispatched;
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text()).catch(() => undefined);
    const ok = router.dispatched > before;
    // A newer apply replaced the router while the probe ran: its own run reports.
    if (installed !== router) return true;
    dispatcherCheck = { ok, at: new Date().toISOString() };
    if (!ok) log.error("[network] fetch() does not use the installed outbound dispatcher on this Node version: the proxy and certificate settings are NOT in force");
    return ok;
  } catch {
    dispatcherCheck = null;
    return true;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
