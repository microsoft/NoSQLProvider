/**
 * TransactionLockHelper.ts
 * Author: David de Regt
 * Copyright: Microsoft 2017
 *
 * Several of the different providers need various types of help enforcing exclusive/readonly transactions.  This helper keeps
 * store-specific lock info and releases transactions at the right time, when the underlying provider can't handle it.
 */

import { ok } from 'assert';
import { map, some, find, each, Dictionary, findIndex } from 'lodash';

import { DbSchema } from './NoSqlProvider';

export interface TransactionToken {
    readonly completionPromise: Promise<void>;
    readonly storeNames: string[];
    readonly exclusive: boolean;
}

class Deferred<T> {
    private _promise: Promise<T>;
    private _reject: (reason?: any) => void = <(reason?: any) => void>(<unknown>undefined);
    private _resolve: (value?: T | PromiseLike<T> | undefined) => void
        = <(value?: T | PromiseLike<T> | undefined) => void>(<unknown>undefined);
    constructor() {
        this._promise = new Promise((resolve, reject) => {
            this._reject = reject;
            this._resolve = resolve;
        });
    }

    public get promise(): Promise<T> {
        return this._promise;
    }

    public resolve(value?: T | PromiseLike<T> | undefined) {
        return this._resolve(value);
    }

    public reject(reason?: any) {
        return this._reject(reason);
    }
}

interface PendingTransaction {
    token: TransactionToken;

    opened: boolean;
    openDefer: Deferred<TransactionToken>;
    completionDefer: Deferred<void> | undefined;
    hadSuccess?: boolean;
}

export class TransactionLockHelper {
    private _closingDefer: Deferred<void> | undefined;
    private _closed = false;

    private _exclusiveLocks: Dictionary<boolean> = {};
    private _readOnlyCounts: Dictionary<number> = {};

    private _pendingTransactions: PendingTransaction[] = [];

    constructor(private _schema: DbSchema, private _supportsDiscreteTransactions: boolean) {
        each(this._schema.stores, store => {
            this._exclusiveLocks[store.name] = false;
            this._readOnlyCounts[store.name] = 0;
        });
    }

    closeWhenPossible(): Promise<void> {
        if (!this._closingDefer) {
            this._closingDefer = new Deferred<void>();
            this._checkClose();
        }

        return this._closingDefer.promise;
    }

    private _checkClose() {
        if (!this._closed && this._closingDefer && !this.hasTransaction()) {
            this._closed = true;
            this._closingDefer.resolve(void 0);
        }
    }

    hasTransaction(): boolean {
        return this._pendingTransactions.length > 0 ||
            some(this._exclusiveLocks, (value) => value) ||
            some(this._readOnlyCounts, (value) => value > 0);
    }

    openTransaction(storeNames: string[] | undefined, exclusive: boolean): Promise<TransactionToken> {
        if (storeNames) {
            const missingStore = find(storeNames, name => !some(this._schema.stores, store => name === store.name));
            if (missingStore) {
                return Promise.reject('Opened a transaction with a store name (' + missingStore + ') not defined in your schema!');
            }
        }

        const completionDefer = new Deferred<void>();
        const newToken: TransactionToken = {
            // Undefined means lock all stores
            storeNames: storeNames || map(this._schema.stores, store => store.name),
            exclusive,
            completionPromise: completionDefer.promise
        };

        const pendingTrans: PendingTransaction = {
            token: newToken,
            opened: false,
            openDefer: new Deferred<TransactionToken>(),
            completionDefer
        };

        this._pendingTransactions.push(pendingTrans);

        this._checkNextTransactions();

        return pendingTrans.openDefer.promise;
    }

    transactionComplete(token: TransactionToken) {
        const pendingTransIndex = findIndex(this._pendingTransactions, trans => trans.token === token);
        if (pendingTransIndex !== -1) {
            const pendingTrans = this._pendingTransactions[pendingTransIndex];
            if (pendingTrans.completionDefer) {
                pendingTrans.hadSuccess = true;

                const toResolve = pendingTrans.completionDefer;
                this._pendingTransactions.splice(pendingTransIndex, 1);
                pendingTrans.completionDefer = undefined;
                toResolve.resolve(void 0);
            } else {
                throw new Error('Completing a transaction that has already been completed. Stores: ' + token.storeNames.join(',') +
                    ', HadSuccess: ' + pendingTrans.hadSuccess);
            }
        } else {
            throw new Error('Completing a transaction that is no longer tracked. Stores: ' + token.storeNames.join(','));
        }

        this._cleanTransaction(token);
    }

    transactionFailed(token: TransactionToken, message: string) {
        const pendingTransIndex = findIndex(this._pendingTransactions, trans => trans.token === token);
        if (pendingTransIndex !== -1) {
            const pendingTrans = this._pendingTransactions[pendingTransIndex];
            if (pendingTrans.completionDefer) {
                pendingTrans.hadSuccess = false;

                const toResolve = pendingTrans.completionDefer;
                this._pendingTransactions.splice(pendingTransIndex, 1);
                pendingTrans.completionDefer = undefined;
                toResolve.reject(new Error(message));
            } else {
                throw new Error('Failing a transaction that has already been completed. Stores: ' + token.storeNames.join(',') +
                    ', HadSuccess: ' + pendingTrans.hadSuccess + ', Message: ' + message);
            }
        } else {
            throw new Error('Failing a transaction that is no longer tracked. Stores: ' + token.storeNames.join(',') + ', message: ' +
                message);
        }

        this._cleanTransaction(token);
    }

    private _cleanTransaction(token: TransactionToken) {
        if (token.exclusive) {
            each(token.storeNames, storeName => {
                ok(this._exclusiveLocks[storeName], 'Missing expected exclusive lock for store: ' + storeName);
                this._exclusiveLocks[storeName] = false;
            });
        } else {
            each(token.storeNames, storeName => {
                ok(this._readOnlyCounts[storeName] > 0, 'Missing expected readonly lock for store: ' + storeName);
                this._readOnlyCounts[storeName]--;
            });
        }

        this._checkNextTransactions();
    }

    private _checkNextTransactions(): void {
        if (some(this._exclusiveLocks, lock => lock) && !this._supportsDiscreteTransactions) {
            // In these cases, no more transactions will be possible.  Break out early.
            return;
        }

        for (let i = 0; i < this._pendingTransactions.length;) {
            const trans = this._pendingTransactions[i];

            if (trans.opened) {
                i++;
                continue;
            }

            if (this._closingDefer) {
                this._pendingTransactions.splice(i, 1);
                trans.openDefer.reject('Closing Provider');
                continue;
            }

            if (some(trans.token.storeNames, storeName => this._exclusiveLocks[storeName] ||
                (trans.token.exclusive && this._readOnlyCounts[storeName] > 0))) {
                i++;
                continue;
            }

            trans.opened = true;

            if (trans.token.exclusive) {
                each(trans.token.storeNames, storeName => {
                    this._exclusiveLocks[storeName] = true;
                });
            } else {
                each(trans.token.storeNames, storeName => {
                    this._readOnlyCounts[storeName]++;
                });
            }

            trans.openDefer.resolve(trans.token);
        }

        this._checkClose();
    }
}
