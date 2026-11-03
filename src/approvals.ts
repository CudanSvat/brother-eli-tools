import { normalizeAddress } from "./config";

export type ApprovalType = "erc20" | "erc721_operator" | "erc1155_operator";

export type ApprovalRow = {
  token: string;
  spender: string;
  type: ApprovalType;
  amount: string | null;
  symbol: string;
  decimals: number;
  spenderName: string | null;
  source: "curated" | "starkscan";
};

export type ApprovalsResponse = {
  address: string;
  approvals: ApprovalRow[];
  meta: {
    curatedChecked: number;
    starkscanUsed: boolean;
    starkscanPages: number;
    starkscanListed?: number;
    starkscanHydrated?: number;
    starkscanParsed?: number;
    starkscanCapped?: boolean;
    warnings: string[];
  };
};

export async function fetchApprovals(owner: string): Promise<ApprovalsResponse> {
  const address = normalizeAddress(owner);
  const base = import.meta.env.BASE_URL || "/tools/revoke/";
  const url = `${base}api/approvals?address=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as ApprovalsResponse & { error?: string };
  if (!res.ok) {
    throw new Error(body.error || `Scan failed (${res.status})`);
  }
  return body;
}
