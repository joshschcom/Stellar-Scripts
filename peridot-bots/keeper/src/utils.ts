import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

export function toAddress(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

export function toU128(value: bigint | number | string): xdr.ScVal {
  const big = typeof value === 'bigint' ? value : BigInt(value);
  if (big < 0n) {
    throw new Error('u128 cannot be negative');
  }
  return nativeToScVal(big, { type: 'u128' });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Runs `fn` every `intervalMs`, swallowing (and logging) errors so a single
 * failed cycle never kills the process.
 */
export async function runLoop(
  name: string,
  intervalMs: number,
  fn: () => Promise<void>,
): Promise<never> {
  // Stagger startup slightly so all loops don't fire at the exact same moment.
  await sleep(Math.floor(Math.random() * 5_000));
  while (true) {
    const started = Date.now();
    try {
      await fn();
    } catch (error) {
      console.error(`[${name}] cycle failed: ${formatError(error)}`);
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(1_000, intervalMs - elapsed));
  }
}
