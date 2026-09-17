import tls from "node:tls";
import { Agent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { SocksClient } from "socks";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

const defaultDispatcher = getGlobalDispatcher();
let appliedSignature: string | null = null;

/**
 * Routes every outbound fetch() (indexers, metadata providers, download-client APIs, webhooks —
 * anything using Node's global fetch, which is undici under the hood) through a SOCKS5 proxy, and/
 * or disables TLS certificate validation for them (Radarr's "Certificate Validation" setting — for
 * an indexer running a self-signed cert). Node's fetch has no native SOCKS support, so this builds
 * a custom undici Agent whose `connect` performs the SOCKS5 handshake via the `socks` package, then
 * installs it as the global dispatcher — the officially documented way to customize connection
 * behavior for every fetch() call app-wide without threading a dispatcher through every call site
 * individually. undici only performs the TLS handshake itself when `connect` is an options
 * object; a custom `connect` function owns TLS, so for https: destinations the SOCKS-tunneled
 * socket is wrapped in `tls.connect` here (honoring the cert-validation setting) — without that,
 * every https fetch through the proxy would write plaintext to port 443.
 */
export function applySocksProxySetting(): void {
  const url = getSetting("socks5ProxyUrl");
  const rejectUnauthorized = getSetting("tlsRejectUnauthorized") !== "0";
  const signature = `${url ?? ""}|${rejectUnauthorized}`;
  if (signature === appliedSignature) return;
  appliedSignature = signature;

  if (!url) {
    if (rejectUnauthorized) {
      setGlobalDispatcher(defaultDispatcher);
    } else {
      setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
      log.warn("[network] TLS certificate validation is DISABLED for all outbound requests");
    }
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
      const isTls = opts.protocol === "https:";
      SocksClient.createConnection({
        proxy: { host: proxyHost, port: proxyPort, type: 5, userId, password },
        command: "connect",
        destination: { host: opts.hostname, port: Number(opts.port) || (isTls ? 443 : 80) },
      })
        .then(({ socket }) => {
          if (!isTls) {
            callback(null, socket);
            return;
          }
          const secure = tls.connect({
            socket,
            servername: opts.servername || opts.hostname,
            rejectUnauthorized,
            ALPNProtocols: ["http/1.1"],
          });
          secure.once("secureConnect", () => callback(null, secure));
          secure.once("error", (err) => callback(err, null));
        })
        .catch((err) => callback(err, null));
    },
  });

  setGlobalDispatcher(agent);
  log.info(`[socksProxy] outbound requests now routed through socks5://${proxyHost}:${proxyPort}`);
}
