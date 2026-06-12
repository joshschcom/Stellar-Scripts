import {
  Account,
  Address,
  Contract,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

import { sleep } from './utils.js';

// 500_000 stroops = 0.05 XLM inclusion fee; keeps mainnet transactions off the floor.
const INCLUSION_FEE = '500000';

export class SorobanClient {
  /** Serializes submissions so concurrent loops never race on the sequence number. */
  private submitQueue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly server: rpc.Server,
    private readonly networkPassphrase: string,
    private readonly signer: Keypair,
  ) {}

  /** Read-only contract call via simulation (free, no signature). */
  async call<T>(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<T> {
    const contract = new Contract(contractId);
    const dummy = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
    const tx = new TransactionBuilder(dummy, {
      fee: INCLUSION_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`simulation error calling ${method}: ${sim.error ?? 'unknown'}`);
    }
    if (!sim.result) {
      throw new Error(`no result returned from simulation of ${method}`);
    }
    return scValToNative(sim.result.retval) as T;
  }

  /** Signed contract invocation. Serialized across all keeper loops. */
  invoke(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<rpc.Api.GetTransactionResponse> {
    return this.enqueue(async () => {
      const account = await this.server.getAccount(this.signer.publicKey());
      const contract = new Contract(contractId);
      let tx = new TransactionBuilder(account, {
        fee: INCLUSION_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call(method, ...args))
        .setTimeout(60)
        .build();

      tx = await this.server.prepareTransaction(tx);
      tx.sign(this.signer);
      return this.submit(tx);
    });
  }

  /**
   * Extends the TTL of the given ledger entries so they live `extendTo`
   * ledgers from now. Entries already above that level are no-ops on-chain.
   */
  extendTtl(keys: xdr.LedgerKey[], extendTo: number): Promise<rpc.Api.GetTransactionResponse> {
    return this.enqueue(async () => {
      const account = await this.server.getAccount(this.signer.publicKey());
      const sorobanData = new SorobanDataBuilder().setReadOnly(keys).build();
      let tx = new TransactionBuilder(account, {
        fee: INCLUSION_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(Operation.extendFootprintTtl({ extendTo }))
        .setSorobanData(sorobanData)
        .setTimeout(60)
        .build();

      tx = await this.server.prepareTransaction(tx);
      tx.sign(this.signer);
      return this.submit(tx);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.submitQueue.then(fn, fn);
    // Keep the chain alive even when a submission fails.
    this.submitQueue = next.catch(() => undefined);
    return next;
  }

  private async submit(
    tx: ReturnType<TransactionBuilder['build']>,
  ): Promise<rpc.Api.GetTransactionResponse> {
    const send = await this.server.sendTransaction(tx);
    if (send.status === 'ERROR') {
      throw new Error(`sendTransaction failed: ${send.errorResult?.toXDR('base64') ?? 'unknown'}`);
    }

    const started = Date.now();
    while (Date.now() - started < 120_000) {
      const res = await this.server.getTransaction(send.hash);
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return res;
      }
      if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`transaction ${send.hash} failed`);
      }
      await sleep(1000);
    }
    throw new Error(`transaction ${send.hash} not confirmed within timeout`);
  }
}

/** Ledger key for a contract's instance entry. */
export function contractInstanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** Ledger key for uploaded contract wasm code. */
export function contractCodeKey(wasmHash: Buffer): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
}
