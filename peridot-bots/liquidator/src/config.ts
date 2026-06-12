import 'dotenv/config';

export interface MarketConfig {
  symbol: string;
  vaultId: string;
  decimals: number;
}

export interface BotConfig {
  rpcUrl: string;
  networkPassphrase: string;
  peridottrollerId: string;
  liquidatorSecret: string;
  markets: MarketConfig[];
  pollIntervalMs: number;
  borrowerRefreshMs: number;
  minShortfall: bigint;
  eventBacklog: number;
  eventPageSize: number;
  // Maps vaultId -> underlying token contract ID, used by the rebalance bot.
  // If omitted, rebalancing is disabled.
  underlyingTokens: Record<string, string>;
  rebalancePollIntervalMs: number;
  telegram: {
    token?: string;
    chatId?: string;
    topicId?: string;
  };
}

function parseMarkets(json?: string | null): MarketConfig[] {
  if (!json) {
    throw new Error('MARKETS_JSON is required (e.g. [{"symbol":"XLM","vaultId":"C...","decimals":7}])');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`MARKETS_JSON is not valid JSON: ${(error as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('MARKETS_JSON must be an array');
  }

  const markets: MarketConfig[] = [];
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as any).symbol !== 'string' ||
      typeof (entry as any).vaultId !== 'string'
    ) {
      throw new Error('MARKETS_JSON entries must include symbol and vaultId');
    }
    const decimals = Number((entry as any).decimals ?? 0);
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new Error(`Invalid decimals for market ${(entry as any).symbol}`);
    }
    markets.push({
      symbol: (entry as any).symbol,
      vaultId: (entry as any).vaultId,
      decimals,
    });
  }
  return markets;
}

export function loadConfig(): BotConfig {
  const networkPassphrase = process.env.NETWORK_PASSPHRASE;
  const rpcUrl = process.env.RPC_URL;
  const peridottrollerId = process.env.PERIDOTTROLLER_ID;
  const liquidatorSecret = process.env.LIQUIDATOR_SECRET;

  if (!networkPassphrase) {
    throw new Error('NETWORK_PASSPHRASE is required');
  }
  if (!rpcUrl) {
    throw new Error('RPC_URL is required');
  }
  if (!peridottrollerId) {
    throw new Error('PERIDOTTROLLER_ID is required');
  }
  if (!liquidatorSecret) {
    throw new Error('LIQUIDATOR_SECRET is required');
  }

  const markets = parseMarkets(process.env.MARKETS_JSON);

  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 5000);
  const borrowerRefreshMs = Number(process.env.BORROWER_REFRESH_MS ?? 15000);
  const minShortfallRaw = process.env.MIN_SHORTFALL ?? '0';
  const eventBacklog = Number(process.env.EVENT_BACKLOG ?? 50);
  const eventPageSize = Number(process.env.EVENT_PAGE_SIZE ?? 50);

  if (
    !Number.isInteger(pollIntervalMs) ||
    !Number.isInteger(borrowerRefreshMs) ||
    pollIntervalMs <= 0 ||
    borrowerRefreshMs <= 0
  ) {
    throw new Error('Invalid poll interval configuration');
  }
  if (!Number.isInteger(eventBacklog) || eventBacklog < 0) {
    throw new Error('EVENT_BACKLOG must be a non-negative integer');
  }
  if (!Number.isInteger(eventPageSize) || eventPageSize <= 0) {
    throw new Error('EVENT_PAGE_SIZE must be a positive integer');
  }

  let minShortfall: bigint;
  try {
    minShortfall = BigInt(minShortfallRaw);
  } catch (error) {
    throw new Error(`MIN_SHORTFALL must be an integer: ${(error as Error).message}`);
  }
  if (minShortfall < 0n) {
    throw new Error('MIN_SHORTFALL cannot be negative');
  }

  const underlyingTokensRaw = process.env.UNDERLYING_TOKENS_JSON;
  let underlyingTokens: Record<string, string> = {};
  if (underlyingTokensRaw) {
    try {
      underlyingTokens = JSON.parse(underlyingTokensRaw);
    } catch {
      throw new Error('UNDERLYING_TOKENS_JSON must be valid JSON');
    }
  }
  const rebalancePollIntervalMs = Number(process.env.REBALANCE_POLL_INTERVAL_MS ?? 60_000);

  return {
    rpcUrl,
    networkPassphrase,
    peridottrollerId,
    liquidatorSecret,
    markets,
    pollIntervalMs,
    borrowerRefreshMs,
    minShortfall,
    eventBacklog,
    eventPageSize,
    underlyingTokens,
    rebalancePollIntervalMs,
    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN || undefined,
      chatId: process.env.TELEGRAM_CHAT_ID || undefined,
      topicId: process.env.TELEGRAM_TOPIC_ID || undefined,
    },
  };
}
