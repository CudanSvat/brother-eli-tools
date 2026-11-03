import "./style.css";
import { SITE, shortAddress, voyagerContract, voyagerTx } from "./config";
import { fetchApprovals, type ApprovalRow } from "./approvals";
import {
  buildRevokeCalls,
  formatAmount,
  isUnlimited,
  rowKey,
  summarizeCalls,
} from "./revoke";
import {
  ensureMainnet,
  forgetWallet,
  onWalletChange,
  pickWallet,
  requestAddress,
  sendCalls,
  walletError,
  type Wallet,
} from "./wallet";

type Phase = "idle" | "connecting" | "scanning" | "ready" | "revoking" | "done";

const state = {
  phase: "idle" as Phase,
  wallet: null as Wallet | null,
  walletName: "",
  address: "",
  approvals: [] as ApprovalRow[],
  selected: new Set<string>(),
  warnings: [] as string[],
  tx: "",
  unwatch: () => {},
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const root = $("#app");
root.innerHTML = `
  <main class="page" id="revoke">
    <section class="sheet hero" id="hero">
      <div class="hero-copy">
        <p class="eyebrow"><span>SLAY utility</span> Starknet · Brother Eli</p>
        <h1>Brother Eli <span>Revoke</span></h1>
        <p class="lede">List every live token allowance on your wallet, tick the ones you want gone, and clear them in one multicall. Your keys never leave your wallet. Only <code>approve(0)</code> and <code>set_approval_for_all(false)</code> are sent.</p>
        <div class="hero-action" id="hero-action"></div>
      </div>
      <div class="wordmark" aria-hidden="true">
        <img src="/tools/revoke/brand/brother-eli-wordmark-v9-640.webp" alt="" width="640" height="320" />
      </div>
    </section>

    <section class="sheet approvals" id="approvals">
      <header class="approvals-head">
        <h2><span class="step">1</span> Your allowances <em id="count"></em></h2>
        <div class="tools" id="tools"></div>
      </header>
      <div class="rows" id="rows"></div>
      <p class="status" id="status" role="status" aria-live="polite"></p>
      <div class="preview" id="preview" hidden></div>
    </section>

    <footer class="foot">
      <p><b>Brother Eli Revoke.</b> This page only builds revoke calls (<code>approve</code> to zero / <code>set_approval_for_all</code> false) and hands them to your wallet to sign. It never sees keys and never transfers tokens. Clearing allowances does not disconnect dapp sessions inside Ready, Braavos, or other wallets — revoke those in the wallet too. Verify you are on <b>brothereli.com/tools/revoke</b>.</p>
      <p class="foot-links">
        <a href="/tools/">Tools</a> ·
        <a href="${SITE}" target="_blank" rel="noreferrer">brothereli.com</a> ·
        <a href="${SITE}/mint" target="_blank" rel="noreferrer">Mint</a> ·
        <a href="${SITE}/marketplace" target="_blank" rel="noreferrer">Marketplace</a>
      </p>
    </footer>
  </main>

  <div class="sendbar" id="sendbar" hidden></div>
`;

function setStatus(msg: string, kind: "" | "ok" | "err" | "busy" = "") {
  const el = $("#status");
  el.className = `status ${kind}`;
  el.innerHTML = msg;
  el.classList.remove("is-fresh");
  void el.offsetWidth;
  el.classList.add("is-fresh");
}

function selectedRows(): ApprovalRow[] {
  return state.approvals.filter((r) => state.selected.has(rowKey(r)));
}

function renderWallet() {
  const busy = state.phase === "connecting";
  const connected = !!state.address;

  $("#hero-action").innerHTML = connected
    ? `<div class="ticket-paper is-in">
         <div>
           <small>${esc(state.walletName || "Wallet")} · Starknet mainnet</small>
           <strong>${esc(shortAddress(state.address))}</strong>
           <span>${state.approvals.length} live approval${state.approvals.length === 1 ? "" : "s"}</span>
         </div>
         <div class="ticket-actions">
           <button type="button" class="ghost" id="btn-rescan" ${state.phase === "scanning" ? "disabled" : ""}>Rescan</button>
           <button type="button" class="ghost" id="btn-disconnect">Disconnect</button>
         </div>
       </div>`
    : `<button type="button" class="tape tape-xl" id="btn-connect" ${busy ? "disabled" : ""}>${
        busy ? "Connecting…" : "Connect wallet"
      }</button>
       <p class="hero-hint">Ready · Braavos · Bramble · Xverse · Cartridge</p>`;

  $("#btn-connect")?.addEventListener("click", () => void onConnect());
  $("#btn-disconnect")?.addEventListener("click", () => void onDisconnect());
  $("#btn-rescan")?.addEventListener("click", () => void onScan());
}

function renderTools() {
  const n = state.approvals.length;
  const sel = state.selected.size;
  $("#count").textContent = n ? String(n) : "";
  $("#tools").innerHTML =
    state.phase === "idle" || !state.address
      ? `<span class="source">Connect to scan</span>`
      : state.phase === "scanning"
        ? `<span class="source">Scanning…</span>`
        : `<button type="button" class="ghost" id="sel-all">Select all</button>
           <button type="button" class="ghost" id="sel-unlimited">Select unlimited</button>
           <button type="button" class="ghost" id="sel-none" ${sel ? "" : "disabled"}>Clear</button>
           <span class="source">${sel} selected</span>`;

  $("#sel-all")?.addEventListener("click", () => {
    state.selected = new Set(state.approvals.map(rowKey));
    renderList();
    renderSendbar();
    renderTools();
  });
  $("#sel-unlimited")?.addEventListener("click", () => {
    state.selected = new Set(
      state.approvals.filter((r) => r.type !== "erc20" || isUnlimited(r.amount)).map(rowKey),
    );
    renderList();
    renderSendbar();
    renderTools();
  });
  $("#sel-none")?.addEventListener("click", () => {
    state.selected.clear();
    renderList();
    renderSendbar();
    renderTools();
  });
}

function typeLabel(row: ApprovalRow): string {
  if (row.type === "erc20") return "ERC-20";
  if (row.type === "erc1155_operator") return "1155 op";
  return "NFT op";
}

function renderList() {
  const box = $("#rows");
  if (!state.address) {
    box.innerHTML = `<div class="empty"><b>No wallet yet</b><span>Connect Ready, Braavos, Bramble, Xverse, or Cartridge to scan live allowances.</span></div>`;
    return;
  }
  if (state.phase === "scanning") {
    box.innerHTML = `<div class="empty"><b>Scanning</b><span>Checking curated routers, then Starkscan history when a key is set.</span></div>`;
    return;
  }
  if (!state.approvals.length) {
    box.innerHTML = `<div class="empty"><b>Clean</b><span>No live allowances found on the curated set${
      state.warnings.some((w) => /STARKSCAN/i.test(w)) ? " (add STARKSCAN_API_KEY for a deeper history scan)" : ""
    }.</span></div>`;
    return;
  }

  box.innerHTML = state.approvals
    .map((row, i) => {
      const key = rowKey(row);
      const checked = state.selected.has(key);
      const hot = row.type !== "erc20" || isUnlimited(row.amount);
      const amt = formatAmount(row);
      const spender = row.spenderName || shortAddress(row.spender);
      return `<button type="button" class="row ${checked ? "is-selected" : ""} ${hot ? "is-hot" : ""}" data-key="${esc(key)}" style="--i:${i}">
        <input type="checkbox" ${checked ? "checked" : ""} tabindex="-1" aria-hidden="true" />
        <span class="token">
          <span class="sym">${esc(row.symbol)}</span>
          <span class="meta"><a href="${voyagerContract(row.token)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">${esc(shortAddress(row.token))}</a></span>
        </span>
        <span class="who">
          <span class="spender">${esc(spender)}</span>
          <span class="meta"><a href="${voyagerContract(row.spender)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">${esc(shortAddress(row.spender))}</a></span>
        </span>
        <span class="amt ${amt === "Unlimited" || amt === "Operator" ? "is-unlimited" : ""}">${esc(amt)}</span>
        <span class="tag">${esc(typeLabel(row))}</span>
      </button>`;
    })
    .join("");

  box.querySelectorAll<HTMLButtonElement>(".row").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key!;
      if (state.selected.has(key)) state.selected.delete(key);
      else state.selected.add(key);
      renderList();
      renderSendbar();
      renderTools();
    });
  });

  const preview = $("#preview");
  const picked = selectedRows();
  if (picked.length) {
    const calls = buildRevokeCalls(picked);
    preview.hidden = false;
    preview.innerHTML = `<strong>Will ask wallet to sign</strong><br/>${esc(summarizeCalls(calls))}`;
  } else {
    preview.hidden = true;
    preview.innerHTML = "";
  }
}

function renderSendbar() {
  const bar = $("#sendbar");
  const n = state.selected.size;
  const show = !!state.address && n > 0 && state.phase !== "scanning";
  document.body.classList.toggle("has-sendbar", show);
  bar.hidden = !show;
  if (!show) return;
  const busy = state.phase === "revoking";
  bar.innerHTML = `
    <div class="sendbar-copy">
      <strong>Revoke ${n} approval${n === 1 ? "" : "s"}</strong>
      <span>${busy ? "Confirm in your wallet…" : "Multicall · approve(0) / set_approval_for_all(false) only"}</span>
    </div>
    <button type="button" class="tape" id="btn-revoke" ${busy ? "disabled" : ""}>${
      busy ? "Revoking…" : "Revoke selected"
    }</button>
  `;
  $("#btn-revoke").addEventListener("click", () => void onRevoke());
}

function renderAll() {
  renderWallet();
  renderTools();
  renderList();
  renderSendbar();
}

async function onConnect() {
  state.phase = "connecting";
  renderAll();
  setStatus("Opening wallet…", "busy");
  try {
    const wallet = await pickWallet(false);
    if (!wallet) {
      state.phase = "idle";
      renderAll();
      setStatus("No wallet selected.", "err");
      return;
    }
    await ensureMainnet(wallet);
    const address = await requestAddress(wallet, false);
    state.wallet = wallet;
    state.walletName = wallet.name || wallet.id || "Wallet";
    state.address = address;
    state.unwatch();
    state.unwatch = onWalletChange(wallet, () => {
      void (async () => {
        try {
          state.address = await requestAddress(wallet, true);
          await onScan();
        } catch {
          await onDisconnect();
        }
      })();
    });
    await onScan();
  } catch (error) {
    state.phase = "idle";
    renderAll();
    setStatus(esc(walletError(error).message), "err");
  }
}

async function onDisconnect() {
  state.unwatch();
  state.unwatch = () => {};
  await forgetWallet();
  state.wallet = null;
  state.walletName = "";
  state.address = "";
  state.approvals = [];
  state.selected.clear();
  state.warnings = [];
  state.tx = "";
  state.phase = "idle";
  renderAll();
  setStatus("");
}

async function onScan() {
  if (!state.address) return;
  state.phase = "scanning";
  state.selected.clear();
  renderAll();
  setStatus("Scanning live allowances…", "busy");
  try {
    const res = await fetchApprovals(state.address);
    state.approvals = res.approvals;
    state.warnings = res.meta.warnings || [];
    state.phase = "ready";
    renderAll();
    const warn = state.warnings[0] ? ` · ${esc(state.warnings[0])}` : "";
    setStatus(
      state.approvals.length
        ? `Found ${state.approvals.length} live approval${state.approvals.length === 1 ? "" : "s"}.${warn}`
        : `No live approvals on this pass.${warn}`,
      state.approvals.length ? "ok" : "",
    );
  } catch (error) {
    state.phase = "ready";
    state.approvals = [];
    renderAll();
    setStatus(esc(error instanceof Error ? error.message : String(error)), "err");
  }
}

async function onRevoke() {
  if (!state.wallet || !state.selected.size) return;
  const rows = selectedRows();
  let calls;
  try {
    calls = buildRevokeCalls(rows);
  } catch (error) {
    setStatus(esc(error instanceof Error ? error.message : String(error)), "err");
    return;
  }
  state.phase = "revoking";
  renderAll();
  setStatus("Confirm the revoke multicall in your wallet…", "busy");
  try {
    const hash = await sendCalls(state.wallet, calls);
    state.tx = hash;
    state.phase = "done";
    setStatus(
      `Revoke sent — <a href="${voyagerTx(hash)}" target="_blank" rel="noreferrer">${esc(shortAddress(hash))}</a>. Rescanning…`,
      "ok",
    );
    await new Promise((r) => setTimeout(r, 4000));
    await onScan();
  } catch (error) {
    state.phase = "ready";
    renderAll();
    setStatus(esc(walletError(error).message), "err");
  }
}

renderAll();
void pickWallet(true).then(async (wallet) => {
  if (!wallet) return;
  try {
    await ensureMainnet(wallet);
    state.wallet = wallet;
    state.walletName = wallet.name || wallet.id || "Wallet";
    state.address = await requestAddress(wallet, true);
    state.unwatch = onWalletChange(wallet, () => void onScan());
    await onScan();
  } catch {
    /* silent reconnect failed — user can click Connect */
  }
});
