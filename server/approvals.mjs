/**
 * Approvals discovery for Brother Eli Revoke.
 * 1) Curated token×spender RPC matrix (fast)
 * 2) Full-chain Starkscan Approval / ApprovalForAll event walk (oldest → newest)
 * 3) Light hydrate of txs whose primaryMethod is approve* (legacy non-indexed events)
 * Then live RPC verify.
 */
import { hash } from "starknet";
import {
  CURATED_SPENDERS,
  getTokenUniverse,
  normalizeAddress,
  spenderName,
  tokenMeta,
} from "./tokens.mjs";

const STARKSCAN = "https://api.starkscan.co/v1/SN_MAIN";
/** Inclusive window size for positional event search (Starkscan free-tier max). */
const EVENT_BLOCK_SPAN = 10_000;
/** Keep concurrency low — free Starkscan keys 429 hard above ~1–2 heavy req/s. */
const EVENT_WINDOW_CONCURRENCY = 2;
const EVENT_PAGE_LIMIT = 100;
/** If first-event probe fails, only walk this many recent blocks (not genesis). */
const EVENT_FALLBACK_LOOKBACK = 400_000;
const VERIFY_CONCURRENCY = 16;
const CACHE_TTL_MS = 5 * 60_000;
/** In-memory full-scan cache (address → result). */
const scanCache = new Map();

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

async function starkscanGet(path, apiKey, attempt = 0) {
  const res = await fetch(`${STARKSCAN}${path}`, {
    headers: {
      Accept: "application/json",
      "X-Starkscan-Api-Key": apiKey,
      "User-Agent": "BrotherEliRevoke/0.1",
    },
  });
  if ((res.status === 429 || res.status === 503) && attempt < 4) {
    const wait = 400 * 2 ** attempt + Math.floor(Math.random() * 200);
    await new Promise((r) => setTimeout(r, wait));
    return starkscanGet(path, apiKey, attempt + 1);
  }
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

function isExplicitApproveRow(row) {
  if (!isSucceededInvoke(row)) return false;
  const method = String(row.primaryMethod || row.primary_method || "").toLowerCase();
  return APPROVE_METHOD_NAMES.has(method) || /approve|allowance|approval_for_all/i.test(method);
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
  const runners = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => run());
  await Promise.all(runners);
  return results;
}

function feltVariants(addr) {
  const padded = normalizeAddress(addr);
  const stripped = `0x${padded.slice(2).replace(/^0+/, "") || "0"}`;
  return [...new Set([padded, stripped])];
}

async function latestBlockNumber() {
  const hex = await rpcCall("starknet_blockNumber", []);
  if (typeof hex === "number") return hex;
  return Number(feltToBigInt(hex));
}

function applyEventToCandidates(candidates, ev, owner) {
  const ownerN = normalizeAddress(owner);
  const name = String(ev.eventName || "").toLowerCase();
  const topic0 = ev.topic0 ? normFelt(ev.topic0) : "";
  const keys = Array.isArray(ev.keys) ? ev.keys : [];
  const data = Array.isArray(ev.data) ? ev.data : [];
  const isApproval = name === "approval" || topic0 === normFelt(SELECTOR.Approval);
  const isApprovalForAll =
    name === "approvalforall" || topic0 === normFelt(SELECTOR.ApprovalForAll);

  const order =
    BigInt(ev.blockNumber || 0) * 1_000_000_000n +
    BigInt(ev.txIndex || 0) * 10_000n +
    BigInt(ev.logIndex || 0);

  if (isApproval) {
    let ownerFelt = ev.topic1 || keys[1];
    let spenderFelt = ev.topic2 || keys[2];
    let low = data[0];
    let high = data[1];
    if ((!ownerFelt || !spenderFelt) && data.length >= 4) {
      ownerFelt = data[0];
      spenderFelt = data[1];
      low = data[2];
      high = data[3];
    }
    if (!ownerFelt || !spenderFelt) return;
    if (normalizeAddress(ownerFelt) !== ownerN) return;
    const amount = parseU256(low ?? "0x0", high ?? "0x0");
    const key = candidateKey(ev.address, spenderFelt, "erc20");
    const prev = candidates.get(key);
    if (prev && prev._order > order) return;
    candidates.set(key, {
      token: normalizeAddress(ev.address),
      spender: normalizeAddress(spenderFelt),
      type: "erc20",
      amount,
      revoked: amount === 0n,
      _order: order,
    });
    return;
  }

  if (isApprovalForAll) {
    let ownerFelt = ev.topic1 || keys[1];
    let operatorFelt = ev.topic2 || keys[2];
    let approvedFelt = data[0];
    if ((!ownerFelt || !operatorFelt) && data.length >= 3) {
      ownerFelt = data[0];
      operatorFelt = data[1];
      approvedFelt = data[2];
    }
    if (!ownerFelt || !operatorFelt) return;
    if (normalizeAddress(ownerFelt) !== ownerN) return;
    const approved = feltToBigInt(approvedFelt) !== 0n;
    const key = candidateKey(ev.address, operatorFelt, "erc721_operator");
    const prev = candidates.get(key);
    if (prev && prev._order > order) return;
    candidates.set(key, {
      token: normalizeAddress(ev.address),
      spender: normalizeAddress(operatorFelt),
      type: "erc721_operator",
      amount: null,
      revoked: !approved,
      _order: order,
    });
  }
}

async function fetchEventWindow(apiKey, topic0, ownerVariants, fromBlock, toBlock) {
  const items = [];
  let cursor = null;
  for (let guard = 0; guard < 40; guard++) {
    const q = new URLSearchParams();
    q.set("topic0", topic0);
    for (const v of ownerVariants) q.append("topic1", v);
    q.set("from_block", String(fromBlock));
    q.set("to_block", String(toBlock));
    q.set("limit", String(EVENT_PAGE_LIMIT));
    if (cursor) q.set("cursor", cursor);
    const page = await starkscanGet(`/events?${q}`, apiKey);
    const batch = page.items || page.data || [];
    items.push(...batch);
    cursor = page.nextCursor || page.next_cursor || null;
    if (!cursor || !batch.length) break;
  }
  return items;
}

/**
 * Full-history Approval walk: every 10k-block window from genesis → head,
 * filtered to this owner as topic1 (SNIP-13 indexed Approval / ApprovalForAll).
 */
async function scanApprovalEvents(owner, apiKey, warnings) {
  const candidates = new Map();
  let head = 0;
  try {
    head = await latestBlockNumber();
  } catch (error) {
    warnings.push(`Could not read chain head: ${error.message || error}`);
    return { candidates, windows: 0, events: 0, head: 0 };
  }

  const ownerVariants = feltVariants(owner);
  const topicApproval = SELECTOR.Approval;
  const topicApprovalForAll = SELECTOR.ApprovalForAll;

  // Skip empty genesis: binary-search the first 10k window with any Approval for this owner.
  let startFrom = 0;
  const lastIdx = Math.floor(head / EVENT_BLOCK_SPAN);
  try {
    let lo = 0;
    let hi = lastIdx;
    let firstIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const from = mid * EVENT_BLOCK_SPAN;
      const to = Math.min(from + EVENT_BLOCK_SPAN - 1, head);
      const hit = await fetchEventWindow(apiKey, topicApproval, ownerVariants, from, to);
      const hit2 =
        hit.length > 0
          ? hit
          : await fetchEventWindow(apiKey, topicApprovalForAll, ownerVariants, from, to);
      if (hit2.length) {
        firstIdx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (firstIdx < 0) {
      return { candidates, windows: 0, events: 0, head };
    }
    startFrom = firstIdx * EVENT_BLOCK_SPAN;
  } catch (error) {
    // Never fall back to genesis on free tier — 17M blocks × windows = instant 429 storm.
    startFrom = Math.max(0, head - EVENT_FALLBACK_LOOKBACK);
    warnings.push(
      `Event probe failed (${String(error.message || error).slice(0, 80)}). Scanning last ~${EVENT_FALLBACK_LOOKBACK} blocks only.`,
    );
  }

  const windows = [];
  for (let from = startFrom; from <= head; from += EVENT_BLOCK_SPAN) {
    const to = Math.min(from + EVENT_BLOCK_SPAN - 1, head);
    windows.push({ from, to });
  }

  let events = 0;
  let windowErrors = 0;

  await mapPool(windows, EVENT_WINDOW_CONCURRENCY, async ({ from, to }) => {
    try {
      const [a, b] = await Promise.all([
        fetchEventWindow(apiKey, topicApproval, ownerVariants, from, to),
        fetchEventWindow(apiKey, topicApprovalForAll, ownerVariants, from, to),
      ]);
      for (const ev of [...a, ...b]) {
        events += 1;
        applyEventToCandidates(candidates, ev, owner);
      }
    } catch (error) {
      windowErrors += 1;
      if (windowErrors <= 3) {
        warnings.push(
          `Event window ${from}-${to} failed: ${String(error.message || error).slice(0, 120)}`,
        );
      }
    }
  });

  // Drop revoked (latest event was zero / false)
  for (const [key, c] of [...candidates.entries()]) {
    if (c.revoked) candidates.delete(key);
    else delete c._order;
  }

  if (windowErrors) {
    warnings.push(
      `Event history incomplete: ${windowErrors}/${windows.length} windows failed (rate limit or coverage).`,
    );
  }

  return { candidates, windows: windows.length, events, head };
}

async function scanStarkscan(owner, apiKey, warnings) {
  // Full history = Approval events (indexed by owner). No per-tx walk —
  // that's what made scans feel slow vs revoke.cash-style index lookups.
  const events = await scanApprovalEvents(owner, apiKey, warnings);

  const uniqWarn = [...new Set(warnings)];
  warnings.length = 0;
  warnings.push(...uniqWarn.slice(0, 10));

  return {
    candidates: events.candidates,
    pages: 0,
    listed: 0,
    hydrated: 0,
    parsedHits: events.candidates.size,
    capped: false,
    eventWindows: events.windows,
    eventHits: events.events,
    headBlock: events.head,
  };
}

function sortApprovals(list) {
  return [...list].sort((a, b) => {
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
}

async function runCuratedMatrix(owner, map, apiKey) {
  const tokens = await getTokenUniverse(owner, apiKey);
  const pairs = [];
  for (const token of tokens) {
    for (const spender of CURATED_SPENDERS) pairs.push({ token, spender });
  }
  // Cap pair fanout so AVNU list × routers stays responsive
  const capped = pairs.length > 2500 ? pairs.slice(0, 2500) : pairs;
  await mapPool(capped, VERIFY_CONCURRENCY, async ({ token, spender }) => {
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
  return { checked: capped.length, tokenCount: tokens.length, spenderCount: CURATED_SPENDERS.length };
}

/**
 * @param {string} ownerRaw
 * @param {{ mode?: 'quick' | 'full' }} [opts]
 */
export async function scanApprovals(ownerRaw, opts = {}) {
  const mode = opts.mode === "quick" ? "quick" : "full";
  const owner = normalizeAddress(ownerRaw);
  const warnings = [];
  const apiKey = process.env.STARKSCAN_API_KEY || "";
  const map = new Map();

  if (mode === "full") {
    const cached = scanCache.get(owner);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { ...cached.result, meta: { ...cached.result.meta, cached: true, mode: "full" } };
    }
  }

  const curated = await runCuratedMatrix(owner, map, apiKey);
  const curatedChecked = curated.checked;

  let starkscanUsed = false;
  let eventWindows = 0;
  let eventHits = 0;
  let headBlock = 0;
  let starkscanParsed = 0;

  if (mode === "full" && apiKey) {
    starkscanUsed = true;
    const scanned = await scanStarkscan(owner, apiKey, warnings);
    eventWindows = scanned.eventWindows || 0;
    eventHits = scanned.eventHits || 0;
    headBlock = scanned.headBlock || 0;
    starkscanParsed = scanned.parsedHits || 0;

    const toVerify = [...scanned.candidates.values()];
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
  } else if (mode === "full" && !apiKey) {
    warnings.push("No STARKSCAN_API_KEY — curated routers only.");
  } else if (mode === "quick") {
    warnings.push(
      `Quick: ${curated.tokenCount} tokens × ${curated.spenderCount} known routers (AVNU list + your transfers). Deep history next…`,
    );
  }

  const result = {
    address: owner,
    approvals: sortApprovals([...map.values()]),
    meta: {
      mode,
      curatedChecked,
      tokenCount: curated.tokenCount,
      spenderCount: curated.spenderCount,
      starkscanUsed,
      starkscanPages: 0,
      starkscanListed: 0,
      starkscanHydrated: 0,
      starkscanParsed,
      starkscanCapped: false,
      eventWindows,
      eventHits,
      headBlock,
      cached: false,
      warnings,
    },
  };

  if (mode === "full" && apiKey) {
    scanCache.set(owner, { at: Date.now(), result });
  }
  return result;
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

  const mode = u.searchParams.get("mode") === "quick" ? "quick" : "full";
  try {
    const result = await scanApprovals(address, { mode });
    sendJson(res, 200, result);
  } catch (error) {
    console.error("scanApprovals:", error);
    sendJson(res, 500, { error: error.message || "Scan failed" });
  }
}
