import type { KeeperConfig } from './config.js';
import { TelegramNotifier } from './notifier.js';
import { SorobanClient } from './soroban.js';
import { snapshotAndReset } from './stats.js';
import { formatError, toAddress } from './utils.js';

// Classic-asset SACs (XLM/USDC/EURC) all use 7 decimals.
const DECIMALS = 7n;
const SCALE = 10n ** DECIMALS;

/**
 * Periodic team report over Telegram: account balances for the keeper and
 * (if configured) the liquidator across every market's underlying token,
 * plus per-loop success/failure counts since the previous report. Also fires
 * a throttled low-balance alert when the keeper's XLM drops below threshold.
 */
export class Reporter {
  constructor(
    private readonly client: SorobanClient,
    private readonly config: KeeperConfig,
    private readonly notifier: TelegramNotifier,
    private readonly keeperPublicKey: string,
    private readonly liquidatorPublicKey?: string,
  ) {}

  async runCycle(): Promise<void> {
    if (!this.notifier.isEnabled) return;

    const lines: string[] = ['Peridot bot report', ''];

    lines.push('Balances (keeper / liquidator):');
    let keeperXlm: bigint | null = null;
    for (const vault of this.config.vaults) {
      try {
        const token = await this.client.call<string>(vault.vaultId, 'get_underlying_token');
        const keeperBal = await this.client
          .call<bigint>(token, 'balance', [toAddress(this.keeperPublicKey)])
          .catch(() => 0n);
        const liqBal = this.liquidatorPublicKey
          ? await this.client
              .call<bigint>(token, 'balance', [toAddress(this.liquidatorPublicKey)])
              .catch(() => 0n)
          : null;

        if (vault.symbol.toUpperCase() === 'XLM') keeperXlm = keeperBal;
        lines.push(
          `  ${vault.symbol}: ${formatAmount(keeperBal)} / ${liqBal === null ? 'n/a' : formatAmount(liqBal)}`,
        );
      } catch (error) {
        lines.push(`  ${vault.symbol}: balance lookup failed (${formatError(error)})`);
      }
    }

    const stats = snapshotAndReset();
    const loops = Object.entries(stats);
    lines.push('', 'Keeper loops since last report:');
    if (loops.length === 0) {
      lines.push('  no completed cycles');
    }
    for (const [loop, s] of loops) {
      const health = s.failed > 0 ? ' ⚠️' : '';
      lines.push(`  ${loop}: ${s.cycles} cycles, ${s.ok} ok, ${s.failed} failed${health}`);
    }

    await this.notifier.send(lines.join('\n'));

    if (keeperXlm !== null && keeperXlm < this.config.keeperMinXlmStroops) {
      await this.notifier.alert(
        'keeper-low-xlm',
        `⚠️ Keeper XLM balance low: ${formatAmount(keeperXlm)} XLM (threshold ${formatAmount(this.config.keeperMinXlmStroops)}). Top up ${this.keeperPublicKey}`,
      );
    }
  }
}

function formatAmount(raw: bigint): string {
  const whole = raw / SCALE;
  const frac = (raw % SCALE).toString().padStart(Number(DECIMALS), '0').slice(0, 2);
  return `${whole}.${frac}`;
}
