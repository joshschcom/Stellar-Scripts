import { rpc, xdr } from '@stellar/stellar-sdk';

import { SorobanClient, contractCodeKey, contractInstanceKey } from './soroban.js';
import { formatError } from './utils.js';

// Soroban caps entry TTL at ~6 months; never ask for more than this.
const MAX_ENTRY_TTL_LEDGERS = 3_110_400;
// Keys per extendFootprintTtl transaction (stays well within footprint limits).
const BATCH_SIZE = 5;

interface Candidate {
  label: string;
  key: xdr.LedgerKey;
}

/**
 * Keeps contract instance and wasm-code ledger entries alive by submitting
 * ExtendFootprintTTL operations for every entry whose remaining TTL has
 * dropped below the configured threshold. Covers contracts that see no
 * regular traffic (and therefore no implicit TTL bumps).
 */
export async function runTtlCycle(
  client: SorobanClient,
  contractIds: string[],
  thresholdLedgers: number,
  extendToLedgers: number,
): Promise<void> {
  if (contractIds.length === 0) return;

  const extendTo = Math.min(extendToLedgers, MAX_ENTRY_TTL_LEDGERS);
  const latest = await client.server.getLatestLedger();
  const extendBelow = latest.sequence + thresholdLedgers;

  const candidates: Candidate[] = [];
  const seenWasmHashes = new Set<string>();

  for (const contractId of contractIds) {
    candidates.push({ label: `${contractId.slice(0, 8)}…/instance`, key: contractInstanceKey(contractId) });
    try {
      const info = await fetchInstanceWasmHash(client.server, contractId);
      if (info && !seenWasmHashes.has(info.toString('hex'))) {
        seenWasmHashes.add(info.toString('hex'));
        candidates.push({ label: `wasm:${info.toString('hex').slice(0, 8)}…`, key: contractCodeKey(info) });
      }
    } catch (error) {
      console.error(`[ttl] failed to resolve wasm for ${contractId}: ${formatError(error)}`);
    }
  }

  // Look up current TTLs in chunks and keep only entries below the threshold.
  const expiring: Candidate[] = [];
  for (let i = 0; i < candidates.length; i += 50) {
    const chunk = candidates.slice(i, i + 50);
    const res = await client.server.getLedgerEntries(...chunk.map(c => c.key));
    for (const entry of res.entries) {
      const keyXdr = entry.key.toXDR('base64');
      const candidate = chunk.find(c => c.key.toXDR('base64') === keyXdr);
      if (!candidate) continue;
      const liveUntil = entry.liveUntilLedgerSeq ?? 0;
      if (liveUntil < extendBelow) {
        expiring.push(candidate);
      }
    }
  }

  if (expiring.length === 0) {
    console.info(`[ttl] cycle done: all ${candidates.length} entries healthy (threshold ${thresholdLedgers} ledgers)`);
    return;
  }

  let extended = 0;
  for (let i = 0; i < expiring.length; i += BATCH_SIZE) {
    const batch = expiring.slice(i, i + BATCH_SIZE);
    try {
      await client.extendTtl(batch.map(c => c.key), extendTo);
      extended += batch.length;
      console.info(`[ttl] extended ${batch.map(c => c.label).join(', ')} to +${extendTo} ledgers`);
    } catch (error) {
      console.error(`[ttl] extend failed for ${batch.map(c => c.label).join(', ')}: ${formatError(error)}`);
    }
  }

  console.info(`[ttl] cycle done: ${extended}/${expiring.length} expiring entries extended`);
}

async function fetchInstanceWasmHash(
  server: rpc.Server,
  contractId: string,
): Promise<Buffer | null> {
  const res = await server.getLedgerEntries(contractInstanceKey(contractId));
  const entry = res.entries[0];
  if (!entry) {
    console.warn(`[ttl] no instance entry found for ${contractId} (archived or wrong ID?)`);
    return null;
  }
  const executable = entry.val.contractData().val().instance().executable();
  // Stellar Asset Contracts have no uploaded wasm.
  if (executable.switch() !== xdr.ContractExecutableType.contractExecutableWasm()) {
    return null;
  }
  return executable.wasmHash();
}
