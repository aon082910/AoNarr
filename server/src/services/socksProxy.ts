import { Agent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { SocksClient } from "socks";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

const defaultDispatcher = getGlobalDispatcher();
let appliedUrl: string | null = null;

/**
 * Routes every outbound fetch() (indexers, metadata providers, download-client APIs, webhooks —
 * anything using Node's global fetch, which is undici under the hood) through a SOCKS5 proxy.
 * Node's fetch has no native SOCKS support, so this builds a custom undici Agent whose `connect`
 * performs the SOCKS5 handshake via the `socks` package, then installs it as the global
 * dispatcher — the officially documented way to customize connection behavior for every fetch()
 * call app-wide without threading a dispatcher through every call site individually.
 */
export function applySocksProxySetting(): void {
  const url = getSetting("socks5ProxyUrl");
  if (url === appliedUrl) return;
  appliedUrl = url;

  if (!url) {
    setGlobalDispatcher(defaultDispatcher);
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    log.error(`[socksProxy] invalid SOCKS5 proxy URL "${url}" — leaving fetch unproxied`);
    return;
  }
  if (parsed.protocol !== "socks5:" && parsed.protocol !== "socks:") {
    log.error(`[socksProxy] proxy URL must start with socks5:// (got "${parsed.protocol}") — leaving fetch unproxied`);
    return;
  }

  const proxyHost = parsed.hostname;
  const proxyPort = Number(parsed.port) || 1080;
  const userId = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;

  const agent = new Agent({
    connect: (opts: any, callback: any) => {
      SocksClient.createConnection({
        proxy: { host: proxyHost, port: proxyPort, type: 5, userId, password },
        command: "connect",
        destination: { host: opts.hostname, port: Number(opts.port) || (opts.protocol === "https:" ? 443 : 80) },
      })
        .then(({ socket }) => callback(null, socket))
        .catch((err) => callback(err, null));
    },
  });

  setGlobalDispatcher(agent);
  log.info(`[socksProxy] outbound requests now routed through socks5://${proxyHost}:${proxyPort}`);
}
