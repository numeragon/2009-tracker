import type { TotpAlgorithm } from "./totp";

export interface TotpAccount {
  id: string;
  label: string;
  secret: string;
  issuer?: string;
  account?: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  createdAt: number;
}

const STORAGE_KEY = "vt:riot_totp_accounts_v1";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `totp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalize(value: unknown): TotpAccount | null {
  const parsed = value as Partial<TotpAccount> | null;
  if (!parsed || typeof parsed.secret !== "string" || !parsed.secret.trim()) {
    return null;
  }
  const algorithm: TotpAlgorithm =
    parsed.algorithm === "SHA-1" || parsed.algorithm === "SHA-512"
      ? parsed.algorithm
      : "SHA-256";
  return {
    id: parsed.id || newId(),
    label: (parsed.label ?? "").trim() || "Riotアカウント",
    secret: parsed.secret.replace(/[\s-]/g, ""),
    issuer: parsed.issuer,
    account: parsed.account,
    algorithm,
    digits:
      typeof parsed.digits === "number" && parsed.digits >= 6 && parsed.digits <= 10
        ? parsed.digits
        : 6,
    period:
      typeof parsed.period === "number" && parsed.period >= 10 && parsed.period <= 120
        ? parsed.period
        : 30,
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
  };
}

export function loadTotpAccounts(): TotpAccount[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalize)
      .filter((account): account is TotpAccount => account !== null);
  } catch {
    return [];
  }
}

export function saveTotpAccounts(accounts: TotpAccount[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
  } catch {
    // Ignore storage errors
  }
}

export function addTotpAccount(input: {
  label: string;
  secret: string;
  issuer?: string;
  account?: string;
  algorithm?: TotpAlgorithm;
  digits?: number;
  period?: number;
}): TotpAccount {
  const accounts = loadTotpAccounts();
  const account: TotpAccount = {
    id: newId(),
    label: input.label.trim() || input.issuer || "Riotアカウント",
    secret: input.secret.replace(/[\s-]/g, ""),
    issuer: input.issuer,
    account: input.account,
    algorithm: input.algorithm ?? "SHA-256",
    digits: input.digits ?? 6,
    period: input.period ?? 30,
    createdAt: Date.now(),
  };
  // Re-adding the same secret just refreshes the label instead of duplicating.
  const existing = accounts.findIndex((item) => item.secret === account.secret);
  if (existing >= 0) {
    accounts[existing] = { ...accounts[existing], label: account.label };
    saveTotpAccounts(accounts);
    return accounts[existing];
  }
  saveTotpAccounts([account, ...accounts]);
  return account;
}

export function removeTotpAccount(id: string): TotpAccount[] {
  const accounts = loadTotpAccounts().filter((account) => account.id !== id);
  saveTotpAccounts(accounts);
  return accounts;
}
