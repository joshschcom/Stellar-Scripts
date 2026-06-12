import { Keypair, rpc } from '@stellar/stellar-sdk';

import { loadConfig } from './config.js';
import { SorobanClient } from './contracts.js';
import { LiquidationBot } from './liquidationBot.js';
import { TelegramNotifier } from './notifier.js';
import { RebalanceBot } from './rebalanceBot.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith('http://') });
  const contracts = new SorobanClient(server, config.networkPassphrase);

  const notifier = new TelegramNotifier(
    config.telegram.token,
    config.telegram.chatId,
    config.telegram.topicId,
  );
  if (notifier.isEnabled) {
    const publicKey = Keypair.fromSecret(config.liquidatorSecret).publicKey();
    await notifier.send(
      `Peridot liquidator started\nAccount: ${publicKey}\nMarkets: ${config.markets.map(m => m.symbol).join(', ')}`,
    );
    console.info('[bot] telegram notifications enabled');
  }

  const liquidationBot = new LiquidationBot(config, server, contracts, notifier);

  const hasRebalanceConfig = Object.keys(config.underlyingTokens).length > 0;
  if (hasRebalanceConfig) {
    const signer = Keypair.fromSecret(config.liquidatorSecret);
    const rebalanceBot = new RebalanceBot(
      contracts,
      signer,
      config.markets,
      config.underlyingTokens,
      config.rebalancePollIntervalMs,
    );
    // Run both bots concurrently; a failure in either rejects the main promise.
    await Promise.all([liquidationBot.start(), rebalanceBot.run()]);
  } else {
    await liquidationBot.start();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
