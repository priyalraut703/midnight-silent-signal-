import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from './managed/lock/contract/index.js';

export type LockPrivateState = {
  readonly secretKey: Uint8Array;
};

export const createLockPrivateState = (secretKey: Uint8Array): LockPrivateState => ({
  secretKey,
});

export const witnesses = {
  secretKey: ({ privateState }: WitnessContext<Ledger, LockPrivateState>): [LockPrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
};