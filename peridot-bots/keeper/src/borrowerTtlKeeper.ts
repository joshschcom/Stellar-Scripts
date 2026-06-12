import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { rpc, scValToNative } from '@stellar/stellar-sdk';

import type { KeeperConfig } from './config.js';
import { SorobanClient } from './soroban.js';
import { formatError, toAddress } from './utils.js';

// Forget borrowers that have had no debt and no activity for this long.
const BORROWER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface KeeperState {
  /** Last ledger fully scanned for events. */
  lastLedger?: number;
  /** address -> last-seen timestamp (ms). */
  borrowers: Record<string, number>;
}

/**
 * Per-user borrow state lives in persistent storage and can expire if a
 * borrower goes quiet, which would break liquidations against them. This
 * keeper discovers borrowers from vault/controller events (same topics the
 * liquidator watches), persists the known set to disk so history survives
 * restarts, and calls the permissionless `bump_user_borrow_ttl(user)` on
 * every vault where the user still has debt.
 */
export class BorrowerTtlKeeper {
  private state: KeeperState = { borrowers: {} };
  private loaded = false;

  constructor(
    private readonly client: SorobanClient,
    private readonly config: KeeperConfig,
  ) {}

  async runCycle(): Promise<void> {
    if (!this.loaded) {
      await this.loadState();
      this.loaded = true;
    }

    await this.scanEvents();
    const bumped = await this.bumpActiveBorrowers();
    await this.saveState();

    console.info(
      `[borrower-ttl] cycle done: tracking ${Object.keys(this.state.borrowers).length} borrowers, bumped ${bumped} vault entries`,
    );
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await readFile(this.config.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as KeeperState;
      if (parsed && typeof parsed === 'object' && parsed.borrowers) {
        this.state = parsed;
        console.info(
          `[borrower-ttl] loaded state: ${Object.keys(this.state.borrowers).length} borrowers, lastLedger=${this.state.lastLedger ?? 'none'}`,
        );
      }
    } catch {
      console.info(`[borrower-ttl] no state file at ${this.config.stateFile}, starting fresh`);
    }
  }

  private async saveState(): Promise<void> {
    await mkdir(dirname(this.config.stateFile), { recursive: true });
    await writeFile(this.config.stateFile, JSON.stringify(this.state), 'utf8');
  }

  private async scanEvents(): Promise<void> {
    const latest = await this.client.server.getLatestLedger();
    let startLedger = this.state.lastLedger
      ? this.state.lastLedger + 1
      : Math.max(1, latest.sequence - this.config.borrowerEventBacklog);
    if (startLedger >= latest.sequence) {
      startLedger = Math.max(1, latest.sequence - 1);
    }

    const contractIds = [
      this.config.peridottrollerId,
      ...this.config.vaults.map(v => v.vaultId),
    ];

    let cursor: string | undefined;
    let pages = 0;
    // Hard page cap as a safety valve against unbounded catch-up loops.
    const MAX_PAGES = 200;

    while (pages < MAX_PAGES) {
      let res: Awaited<ReturnType<rpc.Server['getEvents']>>;
      try {
        res = await this.client.server.getEvents({
          filters: [{ type: 'contract', contractIds }],
          ...(cursor ? { cursor } : { startLedger }),
          limit: this.config.eventPageSize,
        });
      } catch (error) {
        if (!cursor && this.state.lastLedger) {
          // Saved ledger likely outside RPC retention; restart from the backlog window.
          console.warn(`[borrower-ttl] event scan from ledger ${startLedger} failed (${formatError(error)}), falling back to recent window`);
          this.state.lastLedger = undefined;
          startLedger = Math.max(1, latest.sequence - this.config.borrowerEventBacklog);
          continue;
        }
        throw error;
      }

      pages += 1;
      for (const event of res.events) {
        this.handleEvent(event);
      }
      if (res.cursor) cursor = res.cursor;
      if (res.events.length < this.config.eventPageSize) {
        this.state.lastLedger = res.latestLedger ?? latest.sequence;
        break;
      }
    }
  }

  private handleEvent(event: rpc.Api.EventResponse): void {
    if (!Array.isArray(event.topic) || event.topic.length === 0) return;

    let topics: unknown[];
    try {
      topics = event.topic.map(t => scValToNative(t));
    } catch {
      return;
    }
    const name = typeof topics[0] === 'string' ? topics[0].toLowerCase() : '';

    let address: string | undefined;
    if (name === 'borrow_event' || name === 'market_entered' || name === 'mint') {
      address = extractAddress(topics[1]);
    } else if (name === 'repay_borrow') {
      address = extractAddress(topics[2]);
    }

    if (address) {
      this.state.borrowers[address] = Date.now();
    }
  }

  private async bumpActiveBorrowers(): Promise<number> {
    const now = Date.now();
    let bumped = 0;

    for (const [borrower, lastSeen] of Object.entries(this.state.borrowers)) {
      let hasDebt = false;

      for (const vault of this.config.vaults) {
        const debt = await this.client
          .call<bigint>(vault.vaultId, 'get_user_borrow_balance', [toAddress(borrower)])
          .catch(() => 0n);
        if (debt <= 0n) continue;

        hasDebt = true;
        try {
          await this.client.invoke(vault.vaultId, 'bump_user_borrow_ttl', [toAddress(borrower)]);
          bumped += 1;
        } catch (error) {
          console.error(
            `[borrower-ttl] bump failed for ${borrower} on ${vault.symbol}: ${formatError(error)}`,
          );
        }
      }

      if (!hasDebt && now - lastSeen > BORROWER_RETENTION_MS) {
        delete this.state.borrowers[borrower];
      }
    }

    return bumped;
  }
}

function extractAddress(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'address' in value) {
    return (value as { address: string }).address;
  }
  return undefined;
}
