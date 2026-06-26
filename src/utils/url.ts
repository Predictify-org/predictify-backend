import { URL } from "url";
import { lookup } from "dns/promises";
import { isIPv4, isIPv6 } from "net";

const PRIVATE_CIDR_V4: { network: number; bits: number }[] = [
  { network: 0x00000000, bits: 8 },
  { network: 0x0a000000, bits: 8 },
  { network: 0x7f000000, bits: 8 },
  { network: 0xa9fe0000, bits: 16 },
  { network: 0xac100000, bits: 12 },
  { network: 0xc0a80000, bits: 16 },
  { network: 0xc6120000, bits: 15 },
  { network: 0xe0000000, bits: 4 },
  { network: 0xf0000000, bits: 4 },
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  return PRIVATE_CIDR_V4.some((cidr) => {
    const mask = ~0 << (32 - cidr.bits);
    return (addr & mask) >>> 0 === cidr.network;
  });
}

function isPrivateV6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("ff")) return true;
  return false;
}

function isPrivateIp(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateV4(ip);
  if (isIPv6(ip)) return isPrivateV6(ip);
  return true;
}

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
}

export function validateHttpsUrl(raw: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  if (parsed.protocol !== "https:") {
    return { valid: false, error: "evidenceUri must use HTTPS" };
  }

  return { valid: true };
}

export async function validateSsrf(url: string): Promise<UrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  if (parsed.protocol !== "https:") {
    return { valid: false, error: "URL must use HTTPS" };
  }

  try {
    const addresses = await lookup(parsed.hostname, { all: true });
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        return { valid: false, error: `URL resolves to a private IP (${addr.address})` };
      }
    }
  } catch {
    return { valid: false, error: "Failed to resolve hostname" };
  }

  return { valid: true };
}
