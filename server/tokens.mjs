/** Token + spender discovery for the quick scan.
 *
 * Tokens: AVNU community list (fetched) + seed majors + tokens from wallet transfers.
 * Spenders: maintained protocol routers (finite — this is the list we can preset).
 */

export function normalizeAddress(value) {
  let hex = String(value).trim().toLowerCase();
  if (hex.startsWith("0x")) hex = hex.slice(2);
  hex = hex.replace(/^0+/, "") || "0";
  return `0x${hex.padStart(64, "0")}`;
}

/** Always-on majors (also in AVNU list — kept as fallback if fetch fails). */
export const SEED_TOKENS = [
  {
    address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    symbol: "ETH",
    decimals: 18,
    kind: "erc20",
  },
  {
    address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    symbol: "STRK",
    decimals: 18,
    kind: "erc20",
  },
  {
    address: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
    symbol: "USDC",
    decimals: 6,
    kind: "erc20",
  },
  {
    address: "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8",
    symbol: "USDT",
    decimals: 6,
    kind: "erc20",
  },
  {
    address: "0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c667347bdbe9c",
    symbol: "WBTC",
    decimals: 8,
    kind: "erc20",
  },
  {
    address: "0x02ab526354a39e7f5d272f327fa94e757df3688188d4a92c6dc3623ab79894e2",
    symbol: "SLAY",
    decimals: 18,
    kind: "erc20",
  },
  {
    address: "0x062969ccea9a6740d66f2c9aab3f1466f75c5fe21f28355082e20ace7340a289",
    symbol: "ELI",
    decimals: 0,
    kind: "nft",
  },
];

/** @deprecated use SEED_TOKENS / getTokenUniverse — kept for older imports */
export const CURATED_TOKENS = SEED_TOKENS;

/**
 * Known spenders / routers / markets that receive approvals.
 * This is the list that should be curated over time — not every token.
 */
export const CURATED_SPENDERS = [
  // Aggregators / DEX routers
  { address: "0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f", name: "AVNU" },
  { address: "0x041fd22b238fa21cfcf5dd45a8548974d8263b3a531a60388411c5e230f97023", name: "JediSwap v1" },
  { address: "0x0359550b990167afd6635fa574f3bdadd83cb51850e1d00061fe693158c23f80", name: "JediSwap v2" },
  { address: "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b", name: "Ekubo Core" },
  { address: "0x0199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e", name: "Ekubo Router" },
  { address: "0x04505a9f06f2bd639b6601f37a4dc0908bb70e8e0e0c34b1220827d64f4fc066", name: "Ekubo Router 3.0.3" },
  { address: "0x02e0af29598b407c8716b17f6d2795eca1b471413fa03fb145a5e33722184067", name: "Ekubo Positions" },
  { address: "0x00f6f44afb3d9e47219b37f60edafd79241da50a185fa6b2fa15adcd053eaf08", name: "Fibrous" },
  { address: "0x049ff5b3a7d38e2b50198f408fa8281635b5bc81ee49ab87ac36c8324c214427", name: "Nostra Router" },
];

const AVNU_TOKENLIST =
  "https://raw.githubusercontent.com/avnu-labs/token-list/main/src/starknet.tokenlist.json";

let cachedAvnu = { at: 0, tokens: [] };
const AVNU_TTL_MS = 6 * 60 * 60_000;

async function loadAvnuTokenList() {
  if (cachedAvnu.tokens.length && Date.now() - cachedAvnu.at < AVNU_TTL_MS) {
    return cachedAvnu.tokens;
  }
  try {
    const res = await fetch(AVNU_TOKENLIST, {
      headers: { Accept: "application/json", "User-Agent": "BrotherEliRevoke/0.1" },
    });
    if (!res.ok) throw new Error(`AVNU list ${res.status}`);
    const json = await res.json();
    const raw = Array.isArray(json) ? json : json.tokens || json.content || [];
    const tokens = raw
      .map((t) => ({
        address: normalizeAddress(t.address || t.l2_token_address || ""),
        symbol: String(t.symbol || "???").slice(0, 12),
        decimals: Number(t.decimals ?? 18),
        kind: "erc20",
      }))
      .filter((t) => t.address && BigInt(t.address) !== 0n);
    cachedAvnu = { at: Date.now(), tokens };
    return tokens;
  } catch {
    return [];
  }
}

/**
 * Tokens this wallet has touched (transfer history) — discovers unknowns without
 * needing them in a preset list.
 */
async function tokensFromTransfers(owner, apiKey) {
  if (!apiKey) return [];
  const out = new Map();
  let cursor = null;
  try {
    for (let page = 0; page < 8; page++) {
      const q = new URLSearchParams({ direction: "any", limit: "100" });
      if (cursor) q.set("cursor", cursor);
      const res = await fetch(
        `https://api.starkscan.co/v1/SN_MAIN/address/${normalizeAddress(owner)}/transfers?${q}`,
        {
          headers: {
            Accept: "application/json",
            "X-Starkscan-Api-Key": apiKey,
            "User-Agent": "BrotherEliRevoke/0.1",
          },
        },
      );
      if (!res.ok) break;
      const json = await res.json();
      const items = json.items || [];
      for (const row of items) {
        const addr = row.tokenAddress || row.token_address;
        if (!addr) continue;
        const n = normalizeAddress(addr);
        if (!out.has(n)) {
          out.set(n, {
            address: n,
            symbol: shortSym(n),
            decimals: 18,
            kind: row.standard === "erc721" || row.standard === "erc1155" ? "nft" : "erc20",
          });
        }
      }
      cursor = json.nextCursor || json.next_cursor || null;
      if (!cursor || !items.length) break;
    }
  } catch {
    /* ignore — seed + AVNU still work */
  }
  return [...out.values()];
}

function shortSym(addr) {
  const n = normalizeAddress(addr);
  return `0x${n.slice(2, 6)}`;
}

/**
 * Build the token universe for a quick scan:
 * seed majors ∪ AVNU list ∪ tokens from this wallet's transfers.
 */
export async function getTokenUniverse(owner, apiKey) {
  const byAddr = new Map();
  const add = (t) => {
    if (!t?.address) return;
    const n = normalizeAddress(t.address);
    if (BigInt(n) === 0n) return;
    const prev = byAddr.get(n);
    if (!prev || (prev.symbol.startsWith("0x") && t.symbol && !t.symbol.startsWith("0x"))) {
      byAddr.set(n, { ...t, address: n });
    }
  };
  for (const t of SEED_TOKENS) add(t);
  for (const t of await loadAvnuTokenList()) add(t);
  for (const t of await tokensFromTransfers(owner, apiKey)) add(t);
  return [...byAddr.values()];
}

export function tokenMeta(address) {
  const n = normalizeAddress(address);
  return (
    SEED_TOKENS.find((t) => normalizeAddress(t.address) === n) ||
    cachedAvnu.tokens.find((t) => normalizeAddress(t.address) === n)
  );
}

export function spenderName(address) {
  const n = normalizeAddress(address);
  return CURATED_SPENDERS.find((s) => normalizeAddress(s.address) === n)?.name ?? null;
}
