import { Keypair, rpc } from '@stellar/stellar-sdk';

import { BorrowerTtlKeeper } from './borrowerTtlKeeper.js';
import { loadConfig } from './config.js';
import { runInterestCycle } from './interestKeeper.js';
import { runPriceCycle } from './priceKeeper.js';
import { SorobanClient } from './soroban.js';
import { runTtlCycle } from './ttlKeeper.js';
import { runLoop } from './utils.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const signer = Keypair.fromSecret(config.keeperSecret);
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith('http://') });
  const client = new SorobanClient(server, config.networkPassphrase, signer);

  console.info(`[keeper] starting as ${signer.publicKey()}`);
  console.info(
    `[keeper] vaults=${config.vaults.map(v => v.symbol).join(',')} priceTokens=${config.priceTokens.length} ttlContracts=${config.ttlContractIds.length}`,
  );

  const loops: Promise<never>[] = [
    runLoop('interest', config.intervals.interestMs, () => runInterestCycle(client, config.vaults)),
  ];

  if (config.priceTokens.length > 0) {
    loops.push(
      runLoop('price', config.intervals.priceMs, () =>
        runPriceCycle(client, config.peridottrollerId, config.priceTokens),
      ),
    );
  }

  if (config.ttlContractIds.length > 0) {
    loops.push(
      runLoop('ttl', config.intervals.ttlMs, () =>
        runTtlCycle(client, config.ttlContractIds, config.ttl.thresholdLedgers, config.ttl.extendToLedgers),
      ),
    );
  }

  const borrowerTtl = new BorrowerTtlKeeper(client, config);
  loops.push(runLoop('borrower-ttl', config.intervals.borrowerTtlMs, () => borrowerTtl.runCycle()));

  await Promise.all(loops);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
