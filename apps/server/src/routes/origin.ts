/**
 * Origin allowlist shared by CORS (HTTP) and the WebSocket upgrade check: the request's own
 * host, loopback, the configured publicUrl host, tailnet hosts (`*.ts.net`) and private /
 * CGNAT addresses (Tailscale hands out 100.64.0.0/10). Public internet origins are refused.
 */

import net from 'node:net';

export interface OriginPolicy {
  /** the request's `Host` header (host[:port]) */
  requestHost?: string | null;
  /** config.publicUrl */
  publicUrl?: string | null;
}

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

function isPrivateIPv4(host: string): boolean {
  const o = ipv4Octets(host);
  if (!o) return false;
  const [a = 0, b = 0] = o;
  if (a === 127 || a === 10) return true; // loopback, RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (Tailscale)
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Dotted form of an IPv4-mapped IPv6 literal, or null when `h` is not one. Both spellings occur: the dotted
 * `::ffff:127.0.0.1` and the hex `::ffff:7f00:1` — which is what WHATWG `URL.hostname` always produces
 * (`new URL('http://[::ffff:169.254.169.254]/').hostname === '[::ffff:a9fe:a9fe]'`).
 */
function mappedIPv4(h: string): string | null {
  if (!h.startsWith('::ffff:')) return null;
  const tail = h.slice(7);
  if (net.isIPv4(tail)) return tail;
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!m) return null;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** First hextet of an IPv6 literal (0 for a leading `::`). */
function firstHextetOf(h: string): number {
  return h.startsWith(':') ? 0 : parseInt(h.split(':')[0]!, 16);
}

/**
 * Only an actual IPv6 literal qualifies — a hostname such as `fdx.evil.com` must not pass because it
 * happens to start with `fd`. Prefixes are checked on the parsed first hextet (`fc::1` is 0x00fc, not ULA).
 */
function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (!net.isIPv6(h)) return false;
  if (h === '::1') return true;
  if (h.startsWith('::ffff:')) {
    const mapped = mappedIPv4(h);
    return mapped !== null && isPrivateIPv4(mapped);
  }
  const firstHextet = firstHextetOf(h);
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA, incl. Tailscale fd7a:115c:a1e0::/48
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/**
 * Link-local: 169.254.0.0/16 (cloud metadata services live at 169.254.169.254) and fe80::/10, in every spelling a
 * URL host can take — dotted IPv4, an IPv4-mapped IPv6 literal (dotted or hex tail), or an IPv6 literal, with or
 * without brackets. Used to refuse outbound targets (a device-supplied ntfy server) rather than inbound origins.
 */
export function isLinkLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = ipv4Octets(mappedIPv4(h) ?? h);
  if (v4) return v4[0] === 169 && v4[1] === 254;
  if (!net.isIPv6(h)) return false;
  return (firstHextetOf(h) & 0xffc0) === 0xfe80;
}

/** Hostname (no port, no brackets) of `host[:port]`, a URL, or an origin. */
export function hostnameOf(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`);
    return u.hostname.replace(/^\[|\]$/g, '').toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

export function isLocalOrTailnetHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.ts.net')) return true;
  return isPrivateIPv4(h) || isPrivateIPv6(h);
}

/** True when a browser `Origin` may talk to this daemon. */
export function originAllowed(origin: string | null | undefined, policy: OriginPolicy = {}): boolean {
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (isLocalOrTailnetHost(host)) return true;
  const reqHost = hostnameOf(policy.requestHost);
  if (reqHost && reqHost === host) return true;
  const pubHost = hostnameOf(policy.publicUrl);
  if (pubHost && pubHost === host) return true;
  return false;
}
