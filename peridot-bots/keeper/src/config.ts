import 'dotenv/config';

export interface VaultConfig {
  symbol: string;
  vaultId: string;
  /** When true, refresh_boosted_underlying() is called before update_interest(). */
  boosted: boolean;
}

export interface KeeperConfig {
  rpcUrl: string;
  networkPassphrase: string;
  keeperSecret: string;
  peridottrollerId: string;
  vaults: VaultConfig[];
  /** Underlying token contract IDs to pass to controller.cache_price(token). */
  priceTokens: string[];
  /** Contract IDs whose instance (and wasm code) TTL should be kept alive. */
  ttlContractIds: string[];
  intervals: {
    interestMs: number;
    priceMs: number;
    ttlMs: number;
    borrowerTtlMs: number;
    reportMs: number;
  };
  telegram: {
    token?: string;
    chatId?: string;
    topicId?: string;
  };
  /** Low-balance alert threshold for the keeper account, in stroops. */
  keeperMinXlmStroops: bigint;
  /** Optional: lets the report include the liquidator's balances too. */
  liquidatorSecret?: string;
  ttl: {
    /** Extend entries whose remaining TTL is below this many ledgers. */
    thresholdLedgers: number;
    /** Extend entries so they live this many ledgers from now. */
    extendToLedgers: number;
  };
  /** Ledgers to scan back for borrower events on first run (no saved state). */
  borrowerEventBacklog: number;
  eventPageSize: number;
  /** Path of the JSON file used to persist the known-borrower set. */
  stateFile: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function intEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

function parseVaults(json: string): VaultConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`VAULTS_JSON is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('VAULTS_JSON must be an array');
  }
  return parsed.map(entry => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as any).symbol !== 'string' ||
      typeof (entry as any).vaultId !== 'string'
    ) {
      throw new Error('VAULTS_JSON entries must include symbol and vaultId');
    }
    return {
      symbol: (entry as any).symbol,
      vaultId: (entry as any).vaultId,
      boosted: Boolean((entry as any).boosted),
    };
  });
}

function parseStringArray(name: string, json?: string): string[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.some(v => typeof v !== 'string')) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed as string[];
}

export function loadConfig(): KeeperConfig {
  const ONE_MINUTE = 60_000;
  const ONE_HOUR = 60 * ONE_MINUTE;
  const ONE_DAY = 24 * ONE_HOUR;

  // Mainnet ledgers close roughly every 5 seconds: ~17_280 ledgers/day.
  const LEDGERS_PER_DAY = 17_280;

  return {
    rpcUrl: requireEnv('RPC_URL'),
    networkPassphrase: requireEnv('NETWORK_PASSPHRASE'),
    keeperSecret: requireEnv('KEEPER_SECRET'),
    peridottrollerId: requireEnv('PERIDOTTROLLER_ID'),
    vaults: parseVaults(requireEnv('VAULTS_JSON')),
    priceTokens: parseStringArray('PRICE_TOKENS_JSON', process.env.PRICE_TOKENS_JSON),
    ttlContractIds: parseStringArray('TTL_CONTRACT_IDS_JSON', process.env.TTL_CONTRACT_IDS_JSON),
    intervals: {
      interestMs: intEnv('INTEREST_INTERVAL_MS', ONE_HOUR),
      priceMs: intEnv('PRICE_INTERVAL_MS', 10 * ONE_MINUTE),
      ttlMs: intEnv('TTL_INTERVAL_MS', ONE_DAY),
      borrowerTtlMs: intEnv('BORROWER_TTL_INTERVAL_MS', ONE_DAY),
      reportMs: intEnv('REPORT_INTERVAL_MS', ONE_DAY),
    },
    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN || undefined,
      chatId: process.env.TELEGRAM_CHAT_ID || undefined,
      topicId: process.env.TELEGRAM_TOPIC_ID || undefined,
    },
    // KEEPER_MIN_XLM is in whole XLM (default 5); stored in stroops (1e7).
    keeperMinXlmStroops: BigInt(intEnv('KEEPER_MIN_XLM', 5, 0)) * 10_000_000n,
    liquidatorSecret: process.env.LIQUIDATOR_SECRET || undefined,
    ttl: {
      thresholdLedgers: intEnv('TTL_THRESHOLD_LEDGERS', 14 * LEDGERS_PER_DAY),
      extendToLedgers: intEnv('TTL_EXTEND_TO_LEDGERS', 30 * LEDGERS_PER_DAY),
    },
    borrowerEventBacklog: intEnv('BORROWER_EVENT_BACKLOG', LEDGERS_PER_DAY, 0),
    eventPageSize: intEnv('EVENT_PAGE_SIZE', 100),
    stateFile: process.env.STATE_FILE ?? '/data/keeper-state.json',
  };
}
