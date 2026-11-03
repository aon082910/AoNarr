import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";
import { isLocalAddress, parseBypassFilter, proxyUrlProblem, redactProxyUrl } from "./networkAddress.js";
import { planRoute, RoutingDispatcher, socksTunnelAgent, type CertificateMode, type RoutePolicy } from "./outboundRouting.js";

const defaultDispatcher = getGlobalDispatcher();
let appliedSignature: string | null = null;
let installed: RoutingDispatcher | null = null;

/** From the `tlsRejectUnauthorized` setting: "1" always check, "local" skip for local hosts, "0" never check. */
export function certificateMode(): CertificateMode {
  const value = getSetting("tlsRejectUnauthorized");
  return value === "0" ? "disabled" : value === "local" ? "local" : "enabled";
}

/** The proxy URL as a URL, or null (with an error in the log, credentials left out) when it cannot be used. */
function parseProxyUrl(url: string): URL | null {
  const problem = proxyUrlProblem(url);
  if (problem) {
    log.error(`[socksProxy] the proxy URL "${redactProxyUrl(url)}" ${problem}: sending requests without a proxy`);
    return null;
  }
  return new URL(url.trim());
}

/**
 * A request can be between two redirect hops when the settings change, and fetch keeps the
 * dispatcher it started with for the later hops, so the old one is closed after a delay, not at once.
 */
const CLOSE_OLD_DISPATCHER_AFTER_MS = 30_000;

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
  const signature = `${url ?? ""}|${mode}|${bypassLocal}|${filterText}`;
  if (signature === appliedSignature) return;
  appliedSignature = signature;

  // A URL that cannot be used is treated as no proxy, not as "leave the last settings in place": the
  // old proxy must not stay in force, and the certificate setting still applies.
  const proxy = url ? parseProxyUrl(url) : null;

  if (!proxy && mode === "enabled") {
    setGlobalDispatcher(defaultDispatcher);
    closeLater(installed);
    installed = null;
    return;
  }

  // Whether to check the certificate of an https proxy itself: the setting decides, by the proxy's own address.
  const proxyVerify = mode === "disabled" ? false : mode === "local" ? !(proxy && isLocalAddress(proxy.hostname)) : true;

  const filter = parseBypassFilter(filterText, (item) =>
    log.warn(`[socksProxy] ignoring bypass list entry "${item}": only host names, wildcards and IPv4 ranges (a.b.c.d/n) are understood`)
  );
  const agents = new Map<string, Dispatcher>();
  const agentFor = (viaProxy: boolean, verify: boolean): Dispatcher => {
    const key = `${viaProxy ? "proxy" : "direct"}|${verify}`;
    let agent = agents.get(key);
    if (!agent) {
      if (viaProxy && proxy) {
        const web = proxy.protocol === "http:" || proxy.protocol === "https:";
        agent = web
          ? new ProxyAgent({ uri: proxy.href, requestTls: { rejectUnauthorized: verify }, proxyTls: { rejectUnauthorized: proxyVerify } })
          : socksTunnelAgent(proxy, verify);
      } else {
        agent = new Agent({ connect: { rejectUnauthorized: verify } });
      }
      agents.set(key, agent);
    }
    return agent;
  };

  const policy: RoutePolicy = { hasProxy: proxy != null, bypassLocal, filter, certificates: mode };
  const router = new RoutingDispatcher(
    (host) => {
      const plan = planRoute(host, policy);
      return agentFor(plan.viaProxy, plan.verifyCertificate);
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
