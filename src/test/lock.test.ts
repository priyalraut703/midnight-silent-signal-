import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  deployContract,
  submitCallTx,
  type DeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  type EnvironmentConfiguration,
  waitForFunds,
} from '@midnight-ntwrk/testkit-js';
import pino from 'pino';

import { getConfig } from '../config.js';
import {
  MidnightWalletProvider,
  syncWallet,
  type WalletSecret,
} from '../wallet.js';
import { buildProviders, type HelloWorldProviders } from '../providers.js';
import {
  CompiledLockContract,
  Contract,
  ledger,
  zkConfigPath,
  createLockPrivateState,
} from '../../contracts/index.js';

// @ts-expect-error WebSocket global assignment for apollo
globalThis.WebSocket = WebSocket;

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

const ALICE_LOCAL_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';
const PRIVATE_STATE_ID = 'AliceSilentSignalState';

const TEST_SECRET_KEY = new Uint8Array(32).fill(7);
const TEST_HASH = new Uint8Array(32).fill(42);

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty' },
});

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';

function resolveSecret(net: string): WalletSecret {
  if (net === 'local') return { kind: 'seed', value: ALICE_LOCAL_SEED };
  const upper = net.toUpperCase();
  const mnemonicEnv = `MIDNIGHT_${upper}_MNEMONIC`;
  const seedEnv = `MIDNIGHT_${upper}_SEED`;
  const mnemonic = process.env[mnemonicEnv]?.trim().replace(/\s+/g, ' ');
  const seedHex = process.env[seedEnv]?.trim();
  if (mnemonic) return { kind: 'mnemonic', value: mnemonic };
  if (seedHex) return { kind: 'seed', value: seedHex };
  throw new Error(`Either ${mnemonicEnv} or ${seedEnv} is required for network '${net}'.`);
}

describe(`Silent Signal Contract (${network})`, () => {
  let wallet: MidnightWalletProvider;
  let providers: HelloWorldProviders;
  let contractAddress: ContractAddress;

  const config = getConfig();
  const secret = resolveSecret(network);
  const isRemote = config.faucet !== '';
  const syncTimeoutMs = Number(
    process.env['MIDNIGHT_SYNC_TIMEOUT_MS'] ?? (isRemote ? 60 * 60_000 : 10 * 60_000),
  );

  async function queryLedger(p: HelloWorldProviders) {
    const state = await p.publicDataProvider.queryContractState(contractAddress);
    expect(state).not.toBeNull();
    return ledger(state!.data);
  }

  beforeAll(async () => {
    setNetworkId(config.networkId);
    const envConfig: EnvironmentConfiguration = {
      walletNetworkId: config.networkId,
      networkId: config.networkId,
      indexer: config.indexer,
      indexerWS: config.indexerWS,
      node: config.node,
      nodeWS: config.nodeWS,
      faucet: config.faucet,
      proofServer: config.proofServer,
    };

    wallet = await MidnightWalletProvider.build(logger, envConfig, secret);
    await wallet.start();
    await syncWallet(logger, wallet.wallet, syncTimeoutMs);

    if (isRemote) {
      const nightBalance = await waitForFunds(
        wallet.wallet,
        envConfig,
        true,
        wallet.unshieldedKeystore,
      );
      logger.info(`Wallet NIGHT balance on '${network}': ${nightBalance}`);
    }

    providers = buildProviders(wallet, zkConfigPath, config);
    logger.info(`Providers initialized on '${network}'. Ready to test!`);
  });

  afterAll(async () => {
    if (wallet) {
      logger.info('Stopping wallet...');
      await wallet.stop();
    }
  });

  it('Deploys the contract', async () => {
    const deployed: DeployedContract<Contract> = await deployContract<Contract>(providers, {
      compiledContract: CompiledLockContract,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: createLockPrivateState(TEST_SECRET_KEY),
    });

    contractAddress = deployed.deployTxData.public.contractAddress;
    logger.info(`Contract deployed at: ${contractAddress}`);
    expect(contractAddress).toBeDefined();

    const state = await queryLedger(providers);
    expect(state.state).toEqual(0); // UNSET
  });

  it('Locks a secret', async () => {
    await submitCallTx<Contract, 'lockSecret'>(providers, {
      compiledContract: CompiledLockContract,
      contractAddress,
      privateStateId: PRIVATE_STATE_ID,
      circuitId: 'lockSecret',
      args: [TEST_HASH],
    });

    const state = await queryLedger(providers);
    expect(state.state).toEqual(1); // SET
  });

  it('Owner can check in', async () => {
    await submitCallTx<Contract, 'checkIn'>(providers, {
      compiledContract: CompiledLockContract,
      contractAddress,
      privateStateId: PRIVATE_STATE_ID,
      circuitId: 'checkIn',
      args: [],
    });

    const state = await queryLedger(providers);
    expect(state.state).toEqual(1); // still SET
  });

  it('Cannot release before grace period elapses', async () => {
    await expect(
      submitCallTx<Contract, 'checkAndRelease'>(providers, {
        compiledContract: CompiledLockContract,
        contractAddress,
        privateStateId: PRIVATE_STATE_ID,
        circuitId: 'checkAndRelease',
        args: [],
      }),
    ).rejects.toThrow();
  });

  it('Releases the secret after enough missed rounds', async () => {
    // Advance rounds without checking in, to simulate the owner going silent
    for (let i = 0; i < 3; i++) {
      await submitCallTx<Contract, 'tick'>(providers, {
        compiledContract: CompiledLockContract,
        contractAddress,
        privateStateId: PRIVATE_STATE_ID,
        circuitId: 'tick',
        args: [],
      });
    }

    await submitCallTx<Contract, 'checkAndRelease'>(providers, {
      compiledContract: CompiledLockContract,
      contractAddress,
      privateStateId: PRIVATE_STATE_ID,
      circuitId: 'checkAndRelease',
      args: [],
    });

    const state = await queryLedger(providers);
    expect(state.state).toEqual(2); // RELEASED
  });
});