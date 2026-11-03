import { normalizeAddress, U256_MAX } from "./config";
import type { Call } from "./wallet";
import type { ApprovalRow } from "./approvals";

/** Only these entrypoints are ever sent to the wallet. */
const ALLOWED = new Set(["approve", "set_approval_for_all", "setApprovalForAll"]);

function u256Zero(): [string, string] {
  return ["0x0", "0x0"];
}

/** Build allowlisted revoke calls from checked rows. Throws if a row looks wrong. */
export function buildRevokeCalls(rows: ApprovalRow[]): Call[] {
  const calls: Call[] = [];
  for (const row of rows) {
    const token = normalizeAddress(row.token);
    const spender = normalizeAddress(row.spender);
    if (row.type === "erc20") {
      const entry_point = "approve";
      if (!ALLOWED.has(entry_point)) throw new Error("Blocked entrypoint");
      calls.push({
        contract_address: token,
        entry_point,
        calldata: [spender, ...u256Zero()],
      });
      continue;
    }
    const entry_point = "set_approval_for_all";
    if (!ALLOWED.has(entry_point)) throw new Error("Blocked entrypoint");
    calls.push({
      contract_address: token,
      entry_point,
      calldata: [spender, "0x0"],
    });
  }
  return calls;
}

export function isUnlimited(amount: string | null): boolean {
  if (amount == null) return false;
  try {
    const v = BigInt(amount);
    return v >= U256_MAX / 2n;
  } catch {
    return false;
  }
}

export function formatAmount(row: ApprovalRow): string {
  if (row.type !== "erc20") return "Operator";
  if (row.amount == null) return "?";
  if (isUnlimited(row.amount)) return "Unlimited";
  const decimals = row.decimals ?? 18;
  try {
    const raw = BigInt(row.amount);
    if (raw === 0n) return "0";
    const base = 10n ** BigInt(decimals);
    // Dust: positive but under 0.0001 of the token unit
    const dustCut = base / 10_000n; // 1e-4 in token units (0 if decimals < 4)
    if (dustCut > 0n && raw < dustCut) return "<0.0001";
    const whole = raw / base;
    const frac = raw % base;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 4);
    if (!fracStr) return whole.toString();
    // e.g. 0.00004 truncated to 4 places would look like 0.0000 — still dust
    if (whole === 0n && fracStr.replace(/0/g, "") === "") return "<0.0001";
    return `${whole}.${fracStr}`;
  } catch {
    return row.amount;
  }
}

export function rowKey(row: ApprovalRow): string {
  return `${normalizeAddress(row.token)}:${normalizeAddress(row.spender)}:${row.type}`;
}

export function summarizeCalls(calls: Call[]): string {
  return calls
    .map((c) => `${c.entry_point} @ ${c.contract_address.slice(0, 10)}…`)
    .join(" · ");
}
