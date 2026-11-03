# Brother Eli Tools

SLAY utilities for Starknet, served under **[brothereli.com/tools](https://brothereli.com/tools)**.

| Path | Tool | Status |
|------|------|--------|
| `/tools/` | Hub | Live |
| `/tools/revoke/` | Revoke approvals | Live |
| `/tools/dust/` | Dust converter | Soon |
| `/tools/portfolio/` | Portfolio | Soon |

## Revoke

Connect a Starknet wallet, list live token / NFT operator approvals, tick what to clear, revoke in one multicall.

**Canonical URL:** `https://brothereli.com/tools/revoke`

### Safety

- Keys stay in the wallet — no seeds, no private keys.
- Calls are allowlisted to `approve(spender, 0)` and `set_approval_for_all(operator, false)` only.
- `STARKSCAN_API_KEY` is **server-only** (Railway variable). Leave empty to use the curated token×spender matrix; add it later for full history scan. No redeploy of app code required if the var is already declared empty — just set the value and restart.
- Clearing allowances does not disconnect wallet dapp sessions.

## Local

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5175/tools/revoke/` (hub is available via `npm start` after build).

## Railway

1. Deploy this repo (root = repo root).
2. Variables:
   - `STARKSCAN_API_KEY` — optional now; paste when you have it
   - `STARKNET_RPC_URL` — Alchemy Starknet mainnet URL (your API key in the path)
3. Generate a Railway domain, then point `brothereli.com/tools` (and `/tools/*`) at this service (Cloudflare path rule or proxy from the main Brother Eli site).

```bash
npm run build
npm start   # serves /tools/ hub + /tools/revoke/
```

## Wallets

Ready, Braavos, Bramble, Xverse, Cartridge, and other Wallet Standard injectors via get-starknet.
