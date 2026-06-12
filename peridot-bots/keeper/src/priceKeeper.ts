import { SorobanClient } from './soroban.js';
import { formatError, toAddress } from './utils.js';

/**
 * Pre-warms the controller's oracle price cache via the permissionless
 * `cache_price(token)` so liquidity checks and liquidations never see a
 * missing/stale price (missing prices value collateral at $0).
 */
export async function runPriceCycle(
  client: SorobanClient,
  peridottrollerId: string,
  tokens: string[],
): Promise<void> {
  let ok = 0;
  let failed = 0;

  for (const token of tokens) {
    try {
      await client.invoke(peridottrollerId, 'cache_price', [toAddress(token)]);
      ok += 1;
    } catch (error) {
      failed += 1;
      console.error(`[price] cache_price(${token.slice(0, 8)}…) failed: ${formatError(error)}`);
    }
  }

  console.info(`[price] cycle done: ${ok} ok, ${failed} failed (of ${tokens.length} tokens)`);
}
