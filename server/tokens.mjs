/** Token + spender discovery for the quick scan.
 *
 * Tokens: AVNU community list (fetched) + seed majors + tokens from wallet transfers.
 * Spenders: curated protocol hubs + live Troves vault list (API).
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
    address: "0x00da114221cb83fa859dbdb4c44beeaa0bb37c7537ad5ae66fe5e0efd20e6eb3",
    symbol: "DAI",
    decimals: 18,
    kind: "erc20",
  },
  {
    address: "0x0057912720381af14b0e5c87aa4718ed5e527eab60b3801ebf702ab09139e38b",
    symbol: "wstETH",
    decimals: 18,
    kind: "erc20",
  },
  {
    address: "0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a",
    symbol: "xSTRK",
    decimals: 18,
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
 * Known spenders / routers / markets / vaults that receive approvals.
 * Static baseline — getSpenderUniverse() merges live Troves vaults on top.
 */
export const CURATED_SPENDERS = [
  // Aggregators
  { address: "0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f", name: "AVNU" },
  { address: "0x00f6f4cf62e3c010e0ac2451cc7807b5eec19a40b0faacd00cca3914280fdf5a", name: "Fibrous RouterV2" },
  { address: "0x01b23ed400b210766111ba5b1e63e33922c6ba0c45e6ad56ce112e5f4c578e62", name: "Fibrous RouterV1" },
  { address: "0x00f6f44afb3d9e47219b37f60edafd79241da50a185fa6b2fa15adcd053eaf08", name: "Fibrous" },
  { address: "0x06a09ccb1caaecf3d9683efe335a667b2169a409d19c589ba1eb771cd210af75", name: "Fibrous (alt)" },

  // DEX routers
  { address: "0x041fd22b238fa21cfcf5dd45a8548974d8263b3a531a60388411c5e230f97023", name: "JediSwap v1" },
  { address: "0x0359550b990167afd6635fa574f3bdadd83cb51850e1d00061fe693158c23f80", name: "JediSwap v2" },
  { address: "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b", name: "Ekubo Core" },
  { address: "0x0199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e", name: "Ekubo Router" },
  { address: "0x04505a9f06f2bd639b6601f37a4dc0908bb70e8e0e0c34b1220827d64f4fc066", name: "Ekubo Router 3.0.3" },
  { address: "0x02e0af29598b407c8716b17f6d2795eca1b471413fa03fb145a5e33722184067", name: "Ekubo Positions" },
  { address: "0x010884171baf1914edc28d7afb619b40a4051cfae78a094a55d230f19e944a28", name: "mySwap" },
  { address: "0x01114c7103e12c2b2ecbd3a2472ba9c48ddcbf702b1c242dd570057e26212111", name: "mySwap CL" },
  { address: "0x07a6f98c03379b9513ca84cca1373ff452a7462a3b61598f0af5bb27ad7f76d1", name: "10kSwap Router" },
  { address: "0x028c858a586fa12123a1ccb337a0a3b369281f91ea00544d0c086524b759f627", name: "SithSwap Router" },
  { address: "0x02721f5ab785ae5e13b276ca9d41e859b7b150440a288a7826ba5e27dd05e08e", name: "StarkDeFI" },
  { address: "0x038925b0bcf4dce081042ca26a96300d9e181b910328db54a6c89e5451503f5", name: "Haiko" },
  { address: "0x02ffce9d48390d497f7dfafa9dfd22025d9c285135bcc26c955aea8741f081d2", name: "Haiko (alt)" },

  // Nostra
  { address: "0x049ff5b3a7d38e2b50198f408fa8281635b5bc81ee49ab87ac36c8324c214427", name: "Nostra Router" },
  { address: "0x02a93ef8c7679a5f9b1fcf7286a6e1cadf2e9192be4bcb5cb2d1b39062697527", name: "Nostra Factory" },
  { address: "0x073f6addc9339de9822cab4dac8c9431779c09077f02ba7bc36904ea342dd9eb", name: "Nostra CDP" },
  { address: "0x06d272e18e66289eeb874d0206a23afba148ef35f250accfdfdca085a478aec0", name: "Nostra CDP Alpha" },

  // Lending / CDP
  { address: "0x000d8d6dfec4d33bfb6895de9f3852143a17c6f92fd2a21da3d6924d34870160", name: "Vesu Singleton" },
  { address: "0x02545b2e5d519fc230e9cd781046d3a64e092114f07e44771e0d719d148571e3", name: "Vesu Singleton (legacy)" },
  { address: "0x02545b2e5d519fc230e9cd781046d3a64e092114f07e44771e0d719d148725ef", name: "Vesu Singleton (pre-mig)" },
  { address: "0x03630f1f8e5b8f5c4c4ae9b6620f8a570ae55cddebc0276c37550e7c118edf67", name: "Vesu Multiply" },
  { address: "0x07964760e90baa28841ec94714151e03fbc13321797e68a874e88f27c9d58513", name: "Vesu V2 Multiply" },
  { address: "0x0451fe483d5921a2919ddd81d0de6696669bccdacd859f72a4fba7656b97c3b5", name: "Vesu Prime" },
  { address: "0x03976cac265a12609934089004df458ea29c776d77da423c96dc761d09d24124", name: "Vesu Re7 USDC Core" },
  { address: "0x02eef0c13b10b487ea5916b54c0a7f98ec43fb3048f60fdeedaf5b08f6f88aaf", name: "Vesu Re7 USDC Prime" },
  { address: "0x05c03e7e0ccfe79c634782388eb1e6ed4e8e2a013ab0fcc055140805e46261bd", name: "Vesu Re7 USDC Frontier" },
  { address: "0x03a8416bf20d036df5b1cf3447630a2e1cb04685f6b0c3a70ed7fb1473548ecf", name: "Vesu Re7 xBTC" },
  { address: "0x073702fce24aba36da1eac539bd4bae62d4d6a76747b7cdd3e016da754d7a135", name: "Vesu Re7 USDC Stable" },
  { address: "0x04c0a5193d58f74fbace4b74dcf65481e734ed1714121bdc571da345540efa05", name: "zkLend Markets" },
  { address: "0x07e2a13b40fc1119ec55e0bcf9428eedaa581ab3c924561ad4e955f95da63138", name: "zkLend Market (alt)" },
  { address: "0x01b862c518939339b950d0d21a3d4cc8ead102d6270850ac8544636e558fab68", name: "Hashstack Diamond" },
  { address: "0x04d0bb0a4c40012384e7c419e6eb3c637b28e8363fb66958b60d90505b9c072f", name: "Opus Abbot" },
  { address: "0x0315ce9c5d3e5772481181441369d8eea74303b9710a6c72e3fcbbdb83c0dab1", name: "Opus Gate ETH" },
  { address: "0x031a96fe18fe3fdab28822c82c81471f1802800723c8f3e209f1d9da53bc637d", name: "Opus Gate STRK" },
  { address: "0x05bc1c8a78667fac3bf9617903dbf2c1bfe3937e1d37ada3d8b86bf70fb7926e", name: "Opus Gate WBTC" },
  { address: "0x07346e65e80eb61cdfcc56f6f21de07b312e93fe770fb17a6e43c1950acfdbab", name: "Uncap BorrowerOps WBTC" },
  { address: "0x0723a85c8caf8cc4696761f0aae71eb47b2cb2fa6f591ffa231168008a7ea78b", name: "Uncap BorrowerOps tBTC" },

  // Endur LST vaults (ERC-4626 — users approve underlying TO these)
  { address: "0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a", name: "Endur xSTRK" },
  { address: "0x047751b3532fabca89b0f2e35ca1cb45e5a7b11d5e3d3663dfa1f4406b45fd88", name: "Endur strkBTC" },
  { address: "0x06a567e68c805323525fe1649adb80b03cddf92c23d2629a6779f54192dffc13", name: "Endur WBTC vault" },
  { address: "0x043a35c1425a0125ef8c171f1a75c6f31ef8648edcc8324b55ce1917db3f9b91", name: "Endur tBTC vault" },
  { address: "0x07dd3c80de9fcc5545f0cb83678826819c79619ed7992cc06ff81fc67cd2efe0", name: "Endur LBTC vault" },
  { address: "0x0580f3dc564a7b82f21d40d404b3842d490ae7205e6ac07b1b7af2b4a5183dc9", name: "Endur SolvBTC vault" },

  // Options / yield
  { address: "0x047472e6755afc57ada9550b6a3ac93129cc4b5f98f51c73e0644d129fd208d9", name: "Carmine AMM" },
  { address: "0x076dbabc4293db346b0a56b29b6ea9fe18e93742c73f12348c8747ecfc1050aa", name: "Carmine AMM (legacy)" },
  { address: "0x018e009bbb035c506234e7a8eca6a7229adfd59a278ba3845285d28b03ed6d53", name: "Bountive" },
  { address: "0x02fcaebd41710024e25b6dc646a62acb6560125a699a3f695b6adb54a180aaee", name: "Bountive (2)" },
  { address: "0x028a88bf75f1b10dc8552051a56fbdc732084af514f6065f4c67ea6d50204720", name: "Bountive (3)" },
];

const AVNU_TOKENLIST =
  "https://raw.githubusercontent.com/avnu-labs/token-list/main/src/starknet.tokenlist.json";
const TROVES_STRATEGIES = "https://app.troves.fi/api/strategies";

let cachedAvnu = { at: 0, tokens: [] };
let cachedTroves = { at: 0, spenders: [] };
const AVNU_TTL_MS = 6 * 60 * 60_000;
const TROVES_TTL_MS = 60 * 60_000;
/** Extra live spenders merged into name lookup. */
let liveSpenderNames = new Map();

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

/** Troves vault contracts that take ERC-20 approvals on deposit. */
async function loadTrovesVaults() {
  if (cachedTroves.spenders.length && Date.now() - cachedTroves.at < TROVES_TTL_MS) {
    return cachedTroves.spenders;
  }
  try {
    const res = await fetch(TROVES_STRATEGIES, {
      headers: { Accept: "application/json", "User-Agent": "BrotherEliRevoke/0.1" },
    });
    if (!res.ok) throw new Error(`Troves ${res.status}`);
    const json = await res.json();
    const strategies = json.strategies || json || [];
    const out = [];
    const seen = new Set();
    for (const s of strategies) {
      const label = String(s.name || s.id || "Troves").slice(0, 28);
      const contracts = s.contract || s.contracts || [];
      for (const c of contracts) {
        const cname = String(c.name || "").toLowerCase();
        // Only vaults receive underlying approvals; skip managers / oracles / NFTs
        if (cname && cname !== "vault") continue;
        const addr = c.address || c;
        if (!addr || addr === "0x0" || addr === "0x") continue;
        const n = normalizeAddress(addr);
        if (BigInt(n) === 0n || seen.has(n)) continue;
        seen.add(n);
        out.push({ address: n, name: `Troves ${label}` });
      }
    }
    cachedTroves = { at: Date.now(), spenders: out };
    return out;
  } catch {
    return cachedTroves.spenders;
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

/**
 * Spender universe: curated hubs ∪ live Troves vaults.
 */
export async function getSpenderUniverse() {
  const byAddr = new Map();
  const add = (s) => {
    if (!s?.address) return;
    const n = normalizeAddress(s.address);
    if (BigInt(n) === 0n) return;
    if (!byAddr.has(n)) byAddr.set(n, { address: n, name: s.name });
  };
  for (const s of CURATED_SPENDERS) add(s);
  for (const s of await loadTrovesVaults()) add(s);
  const list = [...byAddr.values()];
  liveSpenderNames = new Map(list.map((s) => [s.address, s.name]));
  return list;
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
  return (
    liveSpenderNames.get(n) ||
    CURATED_SPENDERS.find((s) => normalizeAddress(s.address) === n)?.name ||
    null
  );
}
