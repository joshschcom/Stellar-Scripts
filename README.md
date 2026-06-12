# Peridot Server Bots

Self-contained, Docker-Compose-deployable bot stack for the Peridot lending protocol on Stellar **mainnet** (testnet works too — everything is env-driven). Designed to run unattended on a small DigitalOcean droplet or Hetzner VPS.

## What runs

| Service | Container | Purpose |
|---|---|---|
| `liquidator` | `peridot-liquidator` | Watches vault/controller events for borrowers, evaluates `account_liquidity`, and submits `liquidate` transactions when a shortfall appears. Optional idle-cash rebalancer (admin key required). |
| `keeper` | `peridot-keeper` | Protocol maintenance loops (interest, prices, TTL) — detailed below. |

Keeper loops (all intervals configurable via env):

- **interest** (hourly): calls permissionless `update_interest()` on every vault, preceded by `refresh_boosted_underlying()` for DeFindex-boosted markets. Interest accrual is lazy on-chain, so idle markets need this nudge.
- **price** (every 10 min): calls `cache_price(token)` on the controller for each underlying SAC, keeping the oracle cache warm (missing prices value collateral at $0).
- **ttl** (daily): submits `ExtendFootprintTTL` operations for the instance + wasm-code ledger entries of every configured contract (controller, vaults, rate models, PERI token). Only entries below `TTL_THRESHOLD_LEDGERS` remaining are extended, up to `TTL_EXTEND_TO_LEDGERS`.
- **borrower-ttl** (daily): discovers borrowers from chain events, persists the known set to `/data/keeper-state.json` (survives restarts), and calls permissionless `bump_user_borrow_ttl(user)` on every vault where the user has debt — so a quiet borrower's persistent state never expires and breaks liquidation.

## Layout

```
Stellar-Scripts/
├── docker-compose.yml
├── .env.example          # mainnet addresses pre-filled, secrets blank
└── peridot-bots/
    ├── liquidator/       # liquidation + optional rebalance bot
    └── keeper/           # maintenance bot (interest / price / TTL)
```

## Deploying to DigitalOcean or Hetzner

### 1. Provision a server

- **DigitalOcean**: smallest Basic droplet (1 vCPU / 1 GB) is plenty. Choose Ubuntu 24.04 LTS.
- **Hetzner**: CX22 (or even CAX11) with Ubuntu 24.04.

Add your SSH key during creation. Then harden the box:

```bash
ssh root@<server-ip>
apt update && apt upgrade -y
ufw allow OpenSSH && ufw enable
# Disable password login
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

### 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

### 3. Create and fund the bot accounts

Create **two dedicated Stellar keys** (never reuse your admin key for the liquidator):

```bash
stellar keys generate liquidator
stellar keys generate keeper
```

- **Liquidator account**: needs XLM for fees **plus balances of the underlying tokens** (XLM/USDC/EURC) — liquidation repays the borrower's debt from this account via `transfer_from`, in exchange for seized collateral pTokens.
- **Keeper account**: only needs XLM for transaction fees and TTL rent. ~20 XLM lasts a long time; top up occasionally.

### 4. Configure and start

```bash
git clone <your-repo-url> && cd <repo>/Stellar-Scripts
cp .env.example .env
nano .env    # fill in LIQUIDATOR_SECRET and KEEPER_SECRET
docker compose up -d --build
```

All mainnet contract addresses are pre-filled in `.env.example` (from `Peridot-Soroban/peridot-contracts/addresses.md`). For testnet, swap `NETWORK_PASSPHRASE`, `RPC_URL`, and the contract IDs.

### 5. Operate

```bash
# Tail logs
docker compose logs -f
docker compose logs -f keeper
docker compose logs -f liquidator

# Status / restart
docker compose ps
docker compose restart keeper

# Update to a new version
git pull && docker compose up -d --build

# Stop everything
docker compose down
```

Logs are JSON-file with rotation (10 MB x 3 per container), so they won't fill the disk. Keeper state (known borrowers, last scanned ledger) lives in the `bot-state` named volume and survives container rebuilds.

## Configuration reference

See [.env.example](.env.example) for the full annotated list. Key variables:

| Variable | Bot | Notes |
|---|---|---|
| `RPC_URL`, `NETWORK_PASSPHRASE` | both | Mainnet defaults pre-filled |
| `PERIDOTTROLLER_ID` | both | SimplePeridottroller contract |
| `LIQUIDATOR_SECRET` | liquidator | **Required.** Needs underlying-token balances |
| `MARKETS_JSON` | liquidator | `[{symbol, vaultId, decimals}]` |
| `MIN_SHORTFALL` | liquidator | Skip dust liquidations by raising this |
| `UNDERLYING_TOKENS_JSON` | liquidator | Enables rebalance bot — **requires vault admin key**, off by default |
| `KEEPER_SECRET` | keeper | **Required.** Fee-only account |
| `VAULTS_JSON` | keeper | `[{symbol, vaultId, boosted}]` |
| `PRICE_TOKENS_JSON` | keeper | SACs passed to `cache_price`; empty disables the loop |
| `TTL_CONTRACT_IDS_JSON` | keeper | Contracts kept alive by the TTL loop; empty disables it |
| `TTL_THRESHOLD_LEDGERS` / `TTL_EXTEND_TO_LEDGERS` | keeper | Default: extend below ~14 days remaining up to ~30 days |
| `STATE_FILE` | keeper | Defaults to `/data/keeper-state.json` (on the `bot-state` volume) |

## Local development

```bash
cd peridot-bots/keeper        # or peridot-bots/liquidator
npm install
cp .env.example .env          # fill in the secret
npm run dev
```

## Follow-ups (not included)

- Monitoring/alerting: simplest is a [healthchecks.io](https://healthchecks.io) ping from a cron job that checks `docker compose ps`, or shipping logs to a hosted collector.
- `claim_all` reward-distribution keeper: rewards accrue lazily on user actions and don't operationally require a bot.
