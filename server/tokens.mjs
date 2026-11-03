/** Shared curated lists for the approvals scanner (Node). */

export function normalizeAddress(value) {
  let hex = String(value).trim().toLowerCase();
  if (hex.startsWith("0x")) hex = hex.slice(2);
  hex = hex.replace(/^0+/, "") || "0";
  return `0x${hex.padStart(64, "0")}`;
}

export const CURATED_TOKENS = [
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

export const CURATED_SPENDERS = [
  { address: "0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f", name: "AVNU" },
  { address: "0x041fd22b238fa21cfcf5dd45a8548974d8263b3a531a60388411c5e230f97023", name: "JediSwap" },
  {
    address: "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b",
    name: "Ekubo",
  },
];

export function tokenMeta(address) {
  const n = normalizeAddress(address);
  return CURATED_TOKENS.find((t) => normalizeAddress(t.address) === n);
}

export function spenderName(address) {
  const n = normalizeAddress(address);
  return CURATED_SPENDERS.find((s) => normalizeAddress(s.address) === n)?.name ?? null;
}
