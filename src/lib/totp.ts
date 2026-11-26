/**
 * Riot Mobile 2FA is a standard TOTP, but with HMAC-SHA256 (not SHA1).
 * Reference: Askin242/RiotGames-Mobile-2FA-Bypass (`auth_totp.py`).
 */

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface ParsedTotp {
  secret: string;
  issuer?: string;
  account?: string;
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Uint8Array | null {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (clean.length < 8) return null;

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out.length > 0 ? new Uint8Array(out) : null;
}

export function isLikelyBase32(input: string): boolean {
  const clean = input.trim().replace(/[\s-]/g, "");
  return clean.length >= 16 && /^[A-Za-z2-7]+=*$/.test(clean);
}

/**
 * Accepts a raw Base32 secret or an `otpauth://totp/...` URI (including the
 * `?seed=` form used by Riot's 2FA e-mail).
 */
export function parseTotpInput(input: string): ParsedTotp | null {
  const raw = input.trim();
  if (!raw) return null;

  if (/^(otpauth|https?):\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const params = url.searchParams;
      const secret = (params.get("secret") ?? params.get("seed") ?? "").trim();
      if (!isLikelyBase32(secret)) return null;

      const label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      const issuerParam = params.get("issuer") ?? undefined;
      const [labelIssuer, labelAccount] = label.includes(":")
        ? label.split(":", 2)
        : [undefined, label];

      const algorithmParam = (params.get("algorithm") ?? "").toUpperCase();
      const algorithm: TotpAlgorithm =
        algorithmParam === "SHA1"
          ? "SHA-1"
          : algorithmParam === "SHA512"
            ? "SHA-512"
            : algorithmParam === "SHA256"
              ? "SHA-256"
              : "SHA-256";

      const digits = Number(params.get("digits") ?? 6);
      const period = Number(params.get("period") ?? 30);
      return {
        secret,
        issuer: issuerParam ?? labelIssuer,
        account: labelAccount || undefined,
        digits: Number.isFinite(digits) && digits >= 6 && digits <= 10 ? digits : 6,
        period: Number.isFinite(period) && period >= 10 && period <= 120 ? period : 30,
        algorithm,
      };
    } catch {
      return null;
    }
  }

  if (!isLikelyBase32(raw)) return null;
  return {
    secret: raw.replace(/[\s-]/g, ""),
    digits: 6,
    period: 30,
    algorithm: "SHA-256",
  };
}

export interface TotpOptions {
  digits?: number;
  period?: number;
  algorithm?: TotpAlgorithm;
  timestampMs?: number;
}

/** RFC 6238 TOTP. Returns null for an invalid secret. */
export async function generateTotp(
  secret: string,
  options: TotpOptions = {},
): Promise<string | null> {
  const keyBytes = base32Decode(secret);
  if (!keyBytes) return null;
  const digits = options.digits ?? 6;
  const period = options.period ?? 30;
  const algorithm = options.algorithm ?? "SHA-256";
  const now = options.timestampMs ?? Date.now();
  const counter = Math.floor(now / 1000 / period);

  const counterBytes = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i -= 1) {
    counterBytes[i] = value & 0xff;
    value = Math.floor(value / 256);
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes.buffer as ArrayBuffer,
      { name: "HMAC", hash: algorithm },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, counterBytes.buffer as ArrayBuffer),
    );
    const offset = signature[signature.length - 1] & 0x0f;
    const code =
      (((signature[offset] & 0x7f) << 24) |
        ((signature[offset + 1] & 0xff) << 16) |
        ((signature[offset + 2] & 0xff) << 8) |
        (signature[offset + 3] & 0xff)) %
      10 ** digits;
    return code.toString().padStart(digits, "0");
  } catch {
    return null;
  }
}

export function totpRemainingSeconds(period = 30, timestampMs = Date.now()): number {
  const elapsed = Math.floor(timestampMs / 1000) % period;
  return period - elapsed;
}

export function formatTotpCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}
