/**
 * Approvals discovery for Brother Eli Revoke.
 * Curated token×spender matrix + Starkscan history, then live RPC verify.
 *
 * Starkscan accountCalls are { to, selector, calldataLen } only — no calldata.
 * We decode the tx calldata blob and/or Approval / ApprovalForAll logs.
 */
import { hash } from "starknet";
import { CURATED_SPENDERS, CURATED_TOKENS, normalizeAddress, spenderName, tokenMeta } from "./tokens.mjs";

const STARKSCAN = "https://api.starkscan.co/v1/SN_MAIN";
/** List many pages fast (cursor). Not the same as “how many txs you have”. */
const MAX_TX_PAGES = 30;
const PAGE_LIMIT = 100;
/** Detail fetches are expensive — prioritize approve-like, then fill with recent. */
const MAX_HYDRATE_PRIORITY = 80;
const MAX_HYDRATE_RECENT = 40;
const HYDRATE_CONCURRENCY = 12;
const VERIFY_CONCURRENCY = 10;

const SELECTOR = {
  approve: hash.getSelectorFromName("approve"),
  increase_allowance: hash.getSelectorFromName("increase_allowance"),
  increaseAllowance: hash.getSelectorFromName("increaseAllowance"),
  decrease_allowance: hash.getSelectorFromName("decrease_allowance"),
  decreaseAllowance: hash.getSelectorFromName("decreaseAllowance"),
  set_approval_for_all: hash.getSelectorFromName("set_approval_for_all"),
  setApprovalForAll: hash.getSelectorFromName("setApprovalForAll"),
  Approval: hash.getSelectorFromName("Approval"),
  ApprovalForAll: hash.getSelectorFromName("ApprovalForAll"),
};

const APPROVE_SELECTORS = new Set([
  normFelt(SELECTOR.approve),
  normFelt(SELECTOR.increase_allowance),
  normFelt(SELECTOR.increaseAllowance),
  normFelt(SELECTOR.decrease_allowance),
  normFelt(SELECTOR.decreaseAllowance),
]);

const OPERATOR_SELECTORS = new Set([
  normFelt(SELECTOR.set_approval_for_all),
  normFelt(SELECTOR.setApprovalForAll),
]);

const APPROVE_METHOD_NAMES = new Set([
  "approve",
  "increase_allowance",
  "increaseallowance",
  "decrease_allowance",
  "decreaseallowance",
  "set_approval_for_all",
  "setapprovalforall",
]);

const rate = new Map();

function normFelt(value) {
  return normalizeAddress(String(value));
}

function rpcUrl() {
  return (
    process.env.STARKNET_RPC_URL ||
    "https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/demo"
  );
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

/** Decode Cairo account __execute__ calldata: [n, (to, selector, len, data...)×n] */
function decodeNestedCalls(calldata) {
  if (!Array.isArray(calldata) || calldata.length < 1) return null;
  const data = calldata.map(feltToBigInt);
  let i = 0;
  const n = Number(data[i++]);
  if (!Number.isFinite(n) || n < 0 || n > 64) return null;
  const calls = [];
  for (let c = 0; c < n; c++) {
    if (i + 3 > data.length) return null;
    const to = data[i++];
    const selector = data[i++];
    const len = Number(data[i++]);
    if (!Number.isFinite(len) || len < 0 || i + len > data.length) return null;
    const cd = data.slice(i, i + len).map((v) => `0x${v.toString(16)}`);
    i += len;
    calls.push({
      to: `0x${to.toString(16)}`,
      selector: `0x${selector.toString(16)}`,
      calldata: cd,
    });
  }
  if (i !== data.length && i < data.length - 2) {
    // leftover ok for some account wrappers; still return what we parsed if we got calls
  }
  return calls.length ? calls : null;
}

/**
 * Legacy offset format:
 * [n, (to, selector, data_offset, data_len)×n, total_len, ...blob]
 */
function decodeOffsetCalls(calldata) {
  if (!Array.isArray(calldata) || calldata.length < 1) return null;
  const data = calldata.map(feltToBigInt);
  let i = 0;
  const n = Number(data[i++]);
  if (!Number.isFinite(n) || n < 1 || n > 64) return null;
  if (i + n * 4 + 1 > data.length) return null;
  const headers = [];
  for (let c = 0; c < n; c++) {
    headers.push({
      to: data[i++],
      selector: data[i++],
      offset: Number(data[i++]),
      len: Number(data[i++]),
    });
  }
  const total = Number(data[i++]);
  if (!Number.isFinite(total) || i + total > data.length) return null;
  const blob = data.slice(i, i + total);
  const calls = [];
  for (const h of headers) {
    if (!Number.isFinite(h.offset) || !Number.isFinite(h.len) || h.offset + h.len > blob.length) return null;
    const cd = blob.slice(h.offset, h.offset + h.len).map((v) => `0x${v.toString(16)}`);
    calls.push({
      to: `0x${h.to.toString(16)}`,
      selector: `0x${h.selector.toString(16)}`,
      calldata: cd,
    });
  }
  return calls;
}

function parseApproveFromCall(to, selector, calldata) {
  const sel = normFelt(selector);
  const data = (calldata || []).map((c) => (String(c).startsWith("0x") ? String(c) : `0x${c}`));
  if (APPROVE_SELECTORS.has(sel)) {
    if (data.length < 3) return null;
    const amount = parseU256(data[1], data[2]);
    const isDecrease =
      sel === normFelt(SELECTOR.decrease_allowance) || sel === normFelt(SELECTOR.decreaseAllowance);
    return {
      token: normalizeAddress(to),
      spender: normalizeAddress(data[0]),
      type: "erc20",
      amount,
      // decrease alone doesn't mean zero; still keep as candidate and RPC-verify
      revoked: !isDecrease && amount === 0n,
    };
  }
  if (OPERATOR_SELECTORS.has(sel)) {
    if (data.length < 2) return null;
    const approved = feltToBigInt(data[1]) !== 0n;
    return {
      token: normalizeAddress(to),
      spender: normalizeAddress(data[0]),
      type: "erc721_operator",
      amount: null,
      revoked: !approved,
    };
  }
  return null;
}

function parseApproveFromLogs(logs, owner) {
  const out = [];
  if (!Array.isArray(logs)) return out;
  const ownerN = normalizeAddress(owner);
  for (const log of logs) {
    const name = String(log.eventName || "").toLowerCase();
    const topic0 = log.topic0 ? normFelt(log.topic0) : "";
    const keys = Array.isArray(log.keys) ? log.keys : [];
    const data = Array.isArray(log.data) ? log.data : [];
    const isApproval =
      name === "approval" || topic0 === normFelt(SELECTOR.Approval);
    const isApprovalForAll =
      name === "approvalforall" || topic0 === normFelt(SELECTOR.ApprovalForAll);

    if (isApproval) {
      // SNIP-13: keys [selector, owner, spender], data [low, high]
      // Legacy: owner/spender may sit in data
      let ownerFelt = log.topic1 || keys[1];
      let spenderFelt = log.topic2 || keys[2];
      let low = data[0];
      let high = data[1];
      if ((!ownerFelt || !spenderFelt) && data.length >= 4) {
        ownerFelt = data[0];
        spenderFelt = data[1];
        low = data[2];
        high = data[3];
      }
      if (!ownerFelt || !spenderFelt) continue;
      if (normalizeAddress(ownerFelt) !== ownerN) continue;
      const amount = parseU256(low ?? "0x0", high ?? "0x0");
      out.push({
        token: normalizeAddress(log.address),
        spender: normalizeAddress(spenderFelt),
        type: "erc20",
        amount,
        revoked: amount === 0n,
      });
    } else if (isApprovalForAll) {
      let ownerFelt = log.topic1 || keys[1];
      let operatorFelt = log.topic2 || keys[2];
      let approvedFelt = data[0];
      if ((!ownerFelt || !operatorFelt) && data.length >= 3) {
        ownerFelt = data[0];
        operatorFelt = data[1];
        approvedFelt = data[2];
      }
      if (!ownerFelt || !operatorFelt) continue;
      if (normalizeAddress(ownerFelt) !== ownerN) continue;
      const approved = feltToBigInt(approvedFelt) !== 0n;
      out.push({
        token: normalizeAddress(log.address),
        spender: normalizeAddress(operatorFelt),
        type: "erc721_operator",
        amount: null,
        revoked: !approved,
      });
    }
  }
  return out;
}

function extractApproveCandidates(detail, owner) {
  const found = [];

  // 1) Logs (most reliable when decoded)
  found.push(...parseApproveFromLogs(detail.logs, owner));

  // 2) Decode full execute calldata
  const decoded =
    decodeNestedCalls(detail.calldata) || decodeOffsetCalls(detail.calldata) || [];
  for (const call of decoded) {
    const parsed = parseApproveFromCall(call.to, call.selector, call.calldata);
    if (parsed) found.push(parsed);
  }

  // 3) If accountCalls name a approve selector but we still lack calldata,
  //    keep a soft candidate with spender unknown — skip (can't verify without spender).
  //    Instead: if accountCalls length matches and we failed decode, try pairing
  //    accountCalls.to + selector with slices from flat calldata when lengths sum.
  if (!decoded.length && Array.isArray(detail.accountCalls) && Array.isArray(detail.calldata)) {
    const soft = trySliceFromAccountCalls(detail.accountCalls, detail.calldata);
    for (const call of soft) {
      const parsed = parseApproveFromCall(call.to, call.selector, call.calldata);
      if (parsed) found.push(parsed);
    }
  }

  return found;
}

/** Last-resort: walk accountCalls and take sequential tails from calldata by calldataLen. */
function trySliceFromAccountCalls(accountCalls, calldata) {
  // Prefer nested decode of the whole blob first — already tried.
  // Here: find a suffix of calldata that concatenates each call's payload.
  const lens = accountCalls.map((c) => Number(c.calldataLen || 0));
  const total = lens.reduce((a, b) => a + b, 0);
  if (total <= 0 || total > calldata.length) return [];
  const start = calldata.length - total;
  let offset = start;
  const out = [];
  for (let i = 0; i < accountCalls.length; i++) {
    const len = lens[i];
    out.push({
      to: accountCalls[i].to,
      selector: accountCalls[i].selector,
      calldata: calldata.slice(offset, offset + len),
    });
    offset += len;
  }
  return out;
}

function isSucceededInvoke(row) {
  const type = String(row.txType || row.tx_type || "").toUpperCase();
  if (type && type !== "INVOKE") return false;
  const status = String(row.executionStatus || row.execution_status || "").toUpperCase();
  if (status === "REVERTED" || status === "REJECTED") return false;
  return true;
}

/** High chance of an approve nested or as primary method. */
function isPriorityApproveRow(row) {
  if (!isSucceededInvoke(row)) return false;
  const method = String(row.primaryMethod || row.primary_method || "").toLowerCase();
  if (APPROVE_METHOD_NAMES.has(method)) return true;
  if (/approve|allowance|operator/i.test(method)) return true;
  if (row.methodsDiffer || row.methods_differ) return true;
  return false;
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) || 1 }, () => run());
  await Promise.all(runners);
  return results;
}

async function scanStarkscan(owner, apiKey, warnings) {
  const candidates = new Map();
  let cursor = null;
  let pages = 0;
  let listed = 0;
  const priority = [];
  const recent = [];
  let hydrated = 0;
  let parsedHits = 0;

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
      listed += items.length;
      for (const row of items) {
        const h = row.txHash || row.tx_hash;
        if (!h || !isSucceededInvoke(row)) continue;
        if (isPriorityApproveRow(row)) priority.push(h);
        else recent.push(h);
      }
      cursor = page.nextCursor || page.next_cursor || null;
      if (!cursor || !items.length) break;
    }
  } catch (error) {
    warnings.push(`Starkscan list failed: ${error.message || error}`);
    return { candidates, pages, listed, hydrated, parsedHits, capped: false };
  }

  const picked = [];
  const seen = new Set();
  for (const h of priority) {
    if (seen.has(h)) continue;
    seen.add(h);
    picked.push(h);
    if (picked.length >= MAX_HYDRATE_PRIORITY) break;
  }
  for (const h of recent) {
    if (seen.has(h)) continue;
    seen.add(h);
    picked.push(h);
    if (picked.length >= MAX_HYDRATE_PRIORITY + MAX_HYDRATE_RECENT) break;
  }

  const capped = priority.length + recent.length > picked.length;

  await mapPool(picked, HYDRATE_CONCURRENCY, async (txHash) => {
    try {
      const detail = await starkscanGet(`/tx/${txHash}`, apiKey);
      hydrated += 1;
      for (const parsed of extractApproveCandidates(detail, owner)) {
        parsedHits += 1;
        const key = candidateKey(parsed.token, parsed.spender, parsed.type);
        if (parsed.revoked) candidates.delete(key);
        else candidates.set(key, parsed);
      }
    } catch {
      warnings.push(`Tx hydrate failed for ${String(txHash).slice(0, 12)}…`);
    }
  });

  // Dedupe hydrate warnings (can spam under concurrency)
  const uniqWarn = [...new Set(warnings)];
  warnings.length = 0;
  warnings.push(...uniqWarn.slice(0, 8));

  if (!picked.length) {
    warnings.push("Starkscan returned no invoke txs to detail-scan.");
  } else if (!parsedHits) {
    warnings.push(
      `Opened ${hydrated} tx details but found no Approval/approve payloads.`,
    );
  }
  if (capped) {
    warnings.push(
      `Detail cap hit: listed ${listed} txs, opened ${picked.length} details (not your full history).`,
    );
  }

  return { candidates, pages, listed, hydrated, parsedHits, capped };
}

/**
 * Core scan used by HTTP handler.
 */
export async function scanApprovals(ownerRaw) {
  const owner = normalizeAddress(ownerRaw);
  const warnings = [];
  const apiKey = process.env.STARKSCAN_API_KEY || "";
  const map = new Map();

  const pairs = [];
  for (const token of CURATED_TOKENS) {
    for (const spender of CURATED_SPENDERS) {
      pairs.push({ token, spender });
    }
  }
  const curatedChecked = pairs.length;
  await mapPool(pairs, VERIFY_CONCURRENCY, async ({ token, spender }) => {
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
  });

  let starkscanPages = 0;
  let starkscanListed = 0;
  let starkscanUsed = false;
  let starkscanHydrated = 0;
  let starkscanParsed = 0;
  let starkscanCapped = false;
  if (apiKey) {
    starkscanUsed = true;
    const { candidates, pages, listed, hydrated, parsedHits, capped } = await scanStarkscan(
      owner,
      apiKey,
      warnings,
    );
    starkscanPages = pages;
    starkscanListed = listed;
    starkscanHydrated = hydrated;
    starkscanParsed = parsedHits;
    starkscanCapped = !!capped;

    const toVerify = [...candidates.values()];
    await mapPool(toVerify, VERIFY_CONCURRENCY, async (c) => {
      if (c.type === "erc20") {
        const amount = await readAllowance(c.token, owner, c.spender);
        if (amount === 0n) return;
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
        if (!ok) return;
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
    });
  } else {
    warnings.push("No STARKSCAN_API_KEY — showing curated token×spender hits only.");
  }

  const approvals = [...map.values()].sort((a, b) => {
    const score = (r) => {
      if (r.type !== "erc20") return 3;
      try {
        const v = BigInt(r.amount || "0");
        if (v >= 1n << 255n) return 2;
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
    meta: {
      curatedChecked,
      starkscanUsed,
      starkscanPages,
      starkscanListed,
      starkscanHydrated,
      starkscanParsed,
      starkscanCapped,
      warnings,
    },
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
    const result = await scanApprovals(address);
    sendJson(res, 200, result);
  } catch (error) {
    console.error("scanApprovals:", error);
    sendJson(res, 500, { error: error.message || "Scan failed" });
  }
}
