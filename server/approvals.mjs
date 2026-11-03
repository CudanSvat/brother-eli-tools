/**
 * Approvals discovery for Brother Eli Revoke.
 * Curated token×spender matrix + optional Starkscan history, then live RPC verify.
 */
import { CURATED_SPENDERS, CURATED_TOKENS, normalizeAddress, spenderName, tokenMeta } from "./tokens.mjs";

const STARKSCAN = "https://api.starkscan.co/v1/SN_MAIN";
const MAX_TX_PAGES = 15;
const PAGE_LIMIT = 100;
const APPROVE_METHODS = new Set([
  "approve",
  "increase_allowance",
  "increaseallowance",
  "decrease_allowance",
  "decreaseallowance",
  "set_approval_for_all",
  "setapprovalforall",
]);

const rate = new Map();

function rpcUrl() {
  return process.env.STARKNET_RPC_URL || "https://api.cartridge.gg/x/starknet/mainnet";
}

function clientKey(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function rateLimit(req) {
  const key = clientKey(req);
  const now = Date.now();
  const bucket = rate.get(key) || { count: 0, reset: now + 60_000 };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + 60_000;
  }
  bucket.count += 1;
  rate.set(key, bucket);
  return bucket.count <= 30;
}

function readBody(req) {
  return new Promise((resolve) => {
    // GET only for now
    resolve(null);
  });
}

async function rpcCall(method, params) {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

function feltToBigInt(felt) {
  if (felt == null) return 0n;
  const s = String(felt);
  return BigInt(s.startsWith("0x") || s.startsWith("0X") ? s : `0x${s}`);
}

function parseU256(low, high) {
  return feltToBigInt(low) + (feltToBigInt(high) << 128n);
}

async function callByName(contractAddress, entrypoint, calldata) {
  const { hash } = await import("starknet");
  const selector = hash.getSelectorFromName(entrypoint);
  const result = await rpcCall("starknet_call", [
    {
      contract_address: normalizeAddress(contractAddress),
      entry_point_selector: selector,
      calldata: calldata.map((c) => {
        if (typeof c === "bigint") return `0x${c.toString(16)}`;
        const s = String(c);
        return s.startsWith("0x") ? s : `0x${BigInt(s).toString(16)}`;
      }),
    },
    "latest",
  ]);
  return result;
}

async function readAllowance(token, owner, spender) {
  try {
    const out = await callByName(token, "allowance", [normalizeAddress(owner), normalizeAddress(spender)]);
    if (!out || out.length < 2) return 0n;
    return parseU256(out[0], out[1]);
  } catch {
    return 0n;
  }
}

async function readOperator(nft, owner, operator) {
  try {
    const out = await callByName(nft, "is_approved_for_all", [
      normalizeAddress(owner),
      normalizeAddress(operator),
    ]);
    if (!out || !out.length) {
      const camel = await callByName(nft, "isApprovedForAll", [
        normalizeAddress(owner),
        normalizeAddress(operator),
      ]).catch(() => null);
      if (!camel || !camel.length) return false;
      return feltToBigInt(camel[0]) !== 0n;
    }
    return feltToBigInt(out[0]) !== 0n;
  } catch {
    return false;
  }
}

function candidateKey(token, spender, type) {
  return `${normalizeAddress(token)}|${normalizeAddress(spender)}|${type}`;
}

async function starkscanGet(path, apiKey) {
  const res = await fetch(`${STARKSCAN}${path}`, {
    headers: {
      Accept: "application/json",
      "X-Starkscan-Api-Key": apiKey,
      "User-Agent": "BrotherEliRevoke/0.1",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Starkscan ${res.status}: ${text.slice(0, 180)}`);
  }
  return res.json();
}

function methodLooksLikeApprove(name) {
  if (!name) return false;
  return APPROVE_METHODS.has(String(name).toLowerCase());
}

function extractCallsFromTx(detail) {
  const calls = [];
  const bag =
    detail?.calls ||
    detail?.accountCalls ||
    detail?.account_calls ||
    detail?.execution?.calls ||
    detail?.trace?.calls ||
    [];

  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      const entry =
        n.entrypoint || n.entry_point || n.entryPoint || n.method || n.selectorName || n.name;
      const contract =
        n.contractAddress || n.contract_address || n.to || n.address || n.contract;
      const calldata = n.calldata || n.callData || n.inputs || [];
      if (contract && entry) {
        calls.push({
          contract: String(contract),
          entrypoint: String(entry),
          calldata: Array.isArray(calldata) ? calldata.map(String) : [],
        });
      }
      if (n.calls) walk(n.calls);
      if (n.internalCalls) walk(n.internalCalls);
      if (n.internal_calls) walk(n.internal_calls);
    }
  };
  walk(bag);

  // Flat primaryMethod fallback: some list rows only expose method + counterparty
  if (!calls.length && detail?.primaryMethod && detail?.toAddress) {
    calls.push({
      contract: String(detail.toAddress),
      entrypoint: String(detail.primaryMethod),
      calldata: [],
    });
  }
  return calls;
}

function parseApproveCall(call) {
  const name = call.entrypoint.toLowerCase();
  const data = call.calldata.map((c) => (c.startsWith("0x") ? c : `0x${c}`));
  if (name === "approve" || name === "increase_allowance" || name === "increaseallowance") {
    if (data.length < 3) return null;
    const spender = normalizeAddress(data[0]);
    const amount = parseU256(data[1], data[2]);
    return {
      token: normalizeAddress(call.contract),
      spender,
      type: "erc20",
      amount,
      revoked: amount === 0n && (name === "approve"),
    };
  }
  if (name === "set_approval_for_all" || name === "setapprovalforall") {
    if (data.length < 2) return null;
    const operator = normalizeAddress(data[0]);
    const approved = feltToBigInt(data[1]) !== 0n;
    return {
      token: normalizeAddress(call.contract),
      spender: operator,
      type: "erc721_operator",
      amount: null,
      revoked: !approved,
    };
  }
  return null;
}

async function scanStarkscan(owner, apiKey, warnings) {
  const candidates = new Map();
  let cursor = null;
  let pages = 0;
  const approveHashes = [];

  try {
    while (pages < MAX_TX_PAGES) {
      pages += 1;
      const q = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) q.set("cursor", cursor);
      const page = await starkscanGet(
        `/address/${normalizeAddress(owner)}/transactions?${q}`,
        apiKey,
      );
      const items = page.items || page.data || [];
      for (const row of items) {
        const method = row.primaryMethod || row.primary_method || "";
        const differ = row.methodsDiffer || row.methods_differ;
        if (methodLooksLikeApprove(method) || differ) {
          if (row.txHash || row.tx_hash) approveHashes.push(row.txHash || row.tx_hash);
        }
      }
      cursor = page.nextCursor || page.next_cursor || null;
      if (!cursor || !items.length) break;
    }
  } catch (error) {
    warnings.push(`Starkscan list failed: ${error.message || error}`);
    return { candidates, pages };
  }

  // Cap hydrations
  const unique = [...new Set(approveHashes)].slice(0, 80);
  for (const hash of unique) {
    try {
      const detail = await starkscanGet(`/tx/${hash}`, apiKey);
      for (const call of extractCallsFromTx(detail)) {
        const parsed = parseApproveCall(call);
        if (!parsed) continue;
        const key = candidateKey(parsed.token, parsed.spender, parsed.type);
        if (parsed.revoked) {
          candidates.delete(key);
        } else {
          candidates.set(key, parsed);
        }
      }
    } catch (error) {
      warnings.push(`Tx hydrate failed for ${hash.slice(0, 10)}…`);
    }
  }

  return { candidates, pages };
}

/**
 * Core scan used by HTTP handler.
 */
export async function scanApprovals(ownerRaw) {
  const owner = normalizeAddress(ownerRaw);
  const warnings = [];
  const apiKey = process.env.STARKSCAN_API_KEY || "";
  const map = new Map();

  // 1) Curated matrix
  let curatedChecked = 0;
  for (const token of CURATED_TOKENS) {
    for (const spender of CURATED_SPENDERS) {
      curatedChecked += 1;
      if (token.kind === "erc20") {
        const amount = await readAllowance(token.address, owner, spender.address);
        if (amount > 0n) {
          map.set(candidateKey(token.address, spender.address, "erc20"), {
            token: normalizeAddress(token.address),
            spender: normalizeAddress(spender.address),
            type: "erc20",
            amount: amount.toString(),
            symbol: token.symbol,
            decimals: token.decimals,
            spenderName: spender.name,
            source: "curated",
          });
        }
      } else {
        const ok = await readOperator(token.address, owner, spender.address);
        if (ok) {
          map.set(candidateKey(token.address, spender.address, "erc721_operator"), {
            token: normalizeAddress(token.address),
            spender: normalizeAddress(spender.address),
            type: "erc721_operator",
            amount: null,
            symbol: token.symbol,
            decimals: 0,
            spenderName: spender.name,
            source: "curated",
          });
        }
      }
    }
  }

  // 2) Starkscan deepen
  let starkscanPages = 0;
  let starkscanUsed = false;
  if (apiKey) {
    starkscanUsed = true;
    const { candidates, pages } = await scanStarkscan(owner, apiKey, warnings);
    starkscanPages = pages;
    for (const c of candidates.values()) {
      if (c.type === "erc20") {
        const amount = await readAllowance(c.token, owner, c.spender);
        if (amount === 0n) continue;
        const meta = tokenMeta(c.token);
        map.set(candidateKey(c.token, c.spender, "erc20"), {
          token: c.token,
          spender: c.spender,
          type: "erc20",
          amount: amount.toString(),
          symbol: meta?.symbol || shortSym(c.token),
          decimals: meta?.decimals ?? 18,
          spenderName: spenderName(c.spender),
          source: "starkscan",
        });
      } else {
        const ok = await readOperator(c.token, owner, c.spender);
        if (!ok) continue;
        const meta = tokenMeta(c.token);
        map.set(candidateKey(c.token, c.spender, c.type), {
          token: c.token,
          spender: c.spender,
          type: c.type,
          amount: null,
          symbol: meta?.symbol || shortSym(c.token),
          decimals: 0,
          spenderName: spenderName(c.spender),
          source: "starkscan",
        });
      }
    }
  } else {
    warnings.push("No STARKSCAN_API_KEY — showing curated token×spender hits only.");
  }

  const approvals = [...map.values()].sort((a, b) => {
    const score = (r) => {
      if (r.type !== "erc20") return 3;
      try {
        const v = BigInt(r.amount || "0");
        if (v >= (1n << 255n)) return 2;
        return 1;
      } catch {
        return 0;
      }
    };
    return score(b) - score(a);
  });

  return {
    address: owner,
    approvals,
    meta: { curatedChecked, starkscanUsed, starkscanPages, warnings },
  };
}

function shortSym(addr) {
  const n = normalizeAddress(addr);
  return `0x${n.slice(2, 6)}`;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

/** Node http / Connect-style handler. */
export async function handleApprovalsRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Accept");
    res.end();
    return;
  }

  if (req.method && req.method !== "GET") {
    sendJson(res, 405, { error: "GET only" });
    return;
  }

  if (!rateLimit(req)) {
    sendJson(res, 429, { error: "Too many scans — try again in a minute." });
    return;
  }

  const host = req.headers.host || "localhost";
  const u = new URL(req.url || "/", `http://${host}`);
  const address = u.searchParams.get("address") || "";
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address) || BigInt(address) === 0n) {
    sendJson(res, 400, { error: "Valid Starknet address required (?address=0x…)" });
    return;
  }

  try {
    await readBody(req);
    const result = await scanApprovals(address);
    sendJson(res, 200, result);
  } catch (error) {
    console.error("scanApprovals:", error);
    sendJson(res, 500, { error: error.message || "Scan failed" });
  }
}
