import { connect, disconnect, type StarknetWindowObject } from "@starknet-io/get-starknet";
import { RPC_URLS, SN_MAIN } from "./config";

export type Wallet = StarknetWindowObject;

export type Call = { contract_address: string; entry_point: string; calldata: string[] };

const USER_REFUSED = 113;
const UNSUPPORTED = 163;

export function walletError(error: unknown): { message: string; refused: boolean } {
  const e = error as { code?: number; message?: string } | string | undefined;
  const code = typeof e === "object" && e ? e.code : undefined;
  const raw = typeof e === "string" ? e : typeof e === "object" && e?.message ? e.message : "";
  const refused = code === USER_REFUSED || /reject|refus|denied|cancel/i.test(raw);
  if (refused) return { message: "You cancelled in the wallet.", refused };
  return { message: raw || "Wallet request failed. Check the wallet for details.", refused };
}

/** Give late injectors (Bramble / Xverse) a moment before opening the modal. */
function waitForWalletInject(timeoutMs = 2500): Promise<void> {
  return new Promise((resolve) => {
    if (
      "starknet_bramble" in window ||
      "starknet_xverse" in window ||
      "starknet_argentX" in window ||
      "starknet_braavos" in window
    ) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("starknet#initialized", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    window.addEventListener("starknet#initialized", done);
  });
}

/** Ready, Braavos, Bramble, Xverse, Cartridge (and any other Wallet Standard injectors). */
export async function pickWallet(silent = false): Promise<Wallet | null> {
  if (!silent) await waitForWalletInject();
  return connect({
    modalMode: silent ? "neverAsk" : "alwaysAsk",
    modalTheme: "dark",
  });
}

export async function forgetWallet(): Promise<void> {
  try {
    await disconnect({ clearLastWallet: true });
  } catch {
    /* ignore */
  }
}

export async function requestAddress(wallet: Wallet, silent = false): Promise<string> {
  const accounts = (await wallet.request({
    type: "wallet_requestAccounts",
    params: { silent_mode: silent },
  })) as unknown;
  const address = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof address !== "string" || !/^0x[0-9a-f]+$/i.test(address) || BigInt(address) === 0n) {
    throw new Error("No Starknet account shared. Unlock the wallet, pick a Starknet account and approve.");
  }
  return address;
}

export async function ensureMainnet(wallet: Wallet): Promise<void> {
  let chainId = "";
  try {
    chainId = String(await wallet.request({ type: "wallet_requestChainId" }));
  } catch {
    return;
  }
  if (chainId.toLowerCase() === SN_MAIN) return;
  try {
    await wallet.request({ type: "wallet_switchStarknetChain", params: { chainId: SN_MAIN } });
  } catch {
    throw new Error("Switch the wallet to Starknet Mainnet, then connect again.");
  }
}

export async function sendCalls(wallet: Wallet, calls: Call[]): Promise<string> {
  try {
    const res = (await wallet.request({ type: "wallet_addInvokeTransaction", params: { calls } })) as {
      transaction_hash?: string;
    };
    if (!res?.transaction_hash) throw new Error("Wallet did not return a transaction hash");
    return res.transaction_hash;
  } catch (error) {
    const { refused } = walletError(error);
    const code = (error as { code?: number })?.code;
    if (refused || (code !== undefined && code !== UNSUPPORTED)) throw error;
    const { WalletAccount, RpcProvider } = await import("starknet");
    const provider = new RpcProvider({ nodeUrl: RPC_URLS[0], specVersion: "0.8", blockIdentifier: "latest" });
    const account = await WalletAccount.connect(provider, wallet as never);
    const res = await account.execute(
      calls.map((c) => ({
        contractAddress: c.contract_address,
        entrypoint: c.entry_point,
        calldata: c.calldata,
      })),
    );
    return res.transaction_hash;
  }
}

export function onWalletChange(wallet: Wallet, handler: () => void): () => void {
  try {
    wallet.on("accountsChanged", handler);
    wallet.on("networkChanged", handler);
    return () => {
      try {
        wallet.off("accountsChanged", handler);
        wallet.off("networkChanged", handler);
      } catch {
        /* ignore */
      }
    };
  } catch {
    return () => {};
  }
}
