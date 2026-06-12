import type { VaultConfig } from './config.js';
import { SorobanClient } from './soroban.js';
import { recordCycle } from './stats.js';
import { formatError } from './utils.js';

/**
 * Interest accrual on Peridot vaults is lazy (it only runs on user actions),
 * so idle markets drift. This keeper calls the permissionless
 * `update_interest()` on each vault, preceded by `refresh_boosted_underlying()`
 * for DeFindex-boosted vaults so the boosted value cache is fresh when
 * interest is computed. Both calls also bump the vault's core storage TTL.
 */
export async function runInterestCycle(
  client: SorobanClient,
  vaults: VaultConfig[],
): Promise<void> {
  let ok = 0;
  let failed = 0;

  for (const vault of vaults) {
    try {
      if (vault.boosted) {
        await client.invoke(vault.vaultId, 'refresh_boosted_underlying');
      }
      await client.invoke(vault.vaultId, 'update_interest');
      ok += 1;
    } catch (error) {
      failed += 1;
      console.error(`[interest] ${vault.symbol} failed: ${formatError(error)}`);
    }
  }

  recordCycle('interest', ok, failed);
  console.info(`[interest] cycle done: ${ok} ok, ${failed} failed (of ${vaults.length} vaults)`);
}
