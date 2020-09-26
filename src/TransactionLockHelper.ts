/**
 * TransactionLockHelper.ts
 * Author: David de Regt
 * Copyright: Microsoft 2017
 *
 * Several of the different providers need various types of help enforcing exclusive/readonly transactions.  This helper keeps
 * store-specific lock info and releases transactions at the right time, when the underlying provider can't handle it.
 */

import { ok } from 'assert';
import { map, some, find, Dictionary, findIndex } from 'lodash';

import { DbSchema } from './NoSqlProvider';
import * as SyncTasks from 'synctasks';

export interface TransactionToken {
    readonly completionPromise: SyncTasks.Promise<void>;
    readonly storeNames: string[];
    readonly exclusive: boolean;
}

interface PendingTransaction {
    token: TransactionToken;

    opened: boolean;
    openDefer: SyncTasks.Deferred<TransactionToken>;
    completionDefer: SyncTasks.Deferred<void>|undefined;
    hadSuccess?: boolean;
}

export class TransactionLockHelper {
    private _closingDefer: SyncTasks.Deferred<void>|undefined;
    private _closed = false;

    private _exclusiveLocks: Dictionary<boolean> = {};
    private _readOnlyCounts: Dictionary<number> = {};

    private _pendingTransactions: PendingTransaction[] = [];
    
    constructor(private _schema: DbSchema, private _supportsDiscreteTransactions: boolean) {
        for (const store of this._schema.stores) {
            this._exclusiveLocks[store.name] = false;
            this._readOnlyCounts[store.name] = 0;
        }
    }

    closeWhenPossible(): SyncTasks.Promise<void> {
        if (!this._closingDefer) {
            this._closingDefer = SyncTasks.Defer<void>();
            this._checkClose();
        }
        
        return this._closingDefer.promise();
    }

    private _checkClose() {
        if (!this._closed && this._closingDefer && !this.hasTransaction() ) {
            this._closed = true;
            this._closingDefer.resolve(void 0);
        }
    }

    hasTransaction(): boolean {
        return this._pendingTransactions.length > 0 ||
            some(this._exclusiveLocks, (value) => value) ||
            some(this._readOnlyCounts, (value) => value > 0);
    }

    openTransaction(storeNames: string[]|undefined, exclusive: boolean): SyncTasks.Promise<TransactionToken> {
        if (storeNames) {
            const missingStore = find(storeNames, name => !some(this._schema.stores, store => name === store.name));
            if (missingStore) {
                return SyncTasks.Rejected('Opened a transaction with a store name (' + missingStore + ') not defined in your schema!');
            }
        }

        const completionDefer = SyncTasks.Defer<void>();
        const newToken: TransactionToken = {
            // Undefined means lock all stores
            storeNames: storeNames || map(this._schema.stores, store => store.name),
            exclusive,
            completionPromise: completionDefer.promise()
        };

        const pendingTrans: PendingTransaction = {
            token: newToken,
            opened: false,
            openDefer: SyncTasks.Defer<TransactionToken>(),
            completionDefer
        };

        this._pendingTransactions.push(pendingTrans);

        this._checkNextTransactions();

        return pendingTrans.openDefer.promise();
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
            for (const storeName of token.storeNames) {
                ok(this._exclusiveLocks[storeName], 'Missing expected exclusive lock for store: ' + storeName);
                this._exclusiveLocks[storeName] = false;
            }
        } else {
            for (const storeName of token.storeNames) {
                ok(this._readOnlyCounts[storeName] > 0, 'Missing expected readonly lock for store: ' + storeName);
                this._readOnlyCounts[storeName]--;
            }
        }

        this._checkNextTransactions();
    }

    private _checkNextTransactions(): void {
        if (some(this._exclusiveLocks, lock => lock) && !this._supportsDiscreteTransactions) {
            // In these cases, no more transactions will be possible.  Break out early.
            return;
        }

        for (let i = 0; i < this._pendingTransactions.length; ) {
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
                for (const storeName of trans.token.storeNames) {
                    this._exclusiveLocks[storeName] = true;
                }
            } else {
                for (const storeName of trans.token.storeNames) {
                    this._readOnlyCounts[storeName]++;
                }
            }

            trans.openDefer.resolve(trans.token);
        }

        this._checkClose();
    }
}
