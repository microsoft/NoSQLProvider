/**
 * TransactionLockHelper.ts
 * Author: David de Regt
 * Copyright: Microsoft 2017
 *
 * Several of the different providers need various types of help enforcing exclusive/readonly transactions.  This helper keeps
 * store-specific lock info and releases transactions at the right time, when the underlying provider can't handle it.
 */

import assert = require('assert');
import _ = require('lodash');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');

interface PendingTransaction {
    storeNames: string[];
    exclusive: boolean;
    openDefer: SyncTasks.Deferred<TransactionToken>;
}

export interface TransactionToken {
    completionPromise: SyncTasks.Promise<void>;
    storeNames: string[];
    exclusive: boolean;
}

interface TransactionTokenInternal extends TransactionToken {
    completionDefer: SyncTasks.Deferred<void>;
}

class TransactionLockHelper {
    private _closingDefer: SyncTasks.Deferred<void>;
    private _closed = false;

    protected _exclusiveLocks: _.Dictionary<boolean> = {};
    protected _readOnlyCounts: _.Dictionary<number> = {};

    private _pendingTransactions: PendingTransaction[] = [];
    
    constructor(schema: NoSqlProvider.DbSchema, private _supportsDiscreteTransactions: boolean) {
        _.each(schema.stores, store => {
            this._exclusiveLocks[store.name] = false;
            this._readOnlyCounts[store.name] = 0;
        });
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
            this._closingDefer.resolve();
        }
    }

    hasTransaction(): boolean {
        return this._pendingTransactions.length > 0 ||
            _.some(this._exclusiveLocks, (value) => value) ||
            _.some(this._readOnlyCounts, (value) => value > 0);
    }

    openTransaction(storeNames: string[], exclusive: boolean): SyncTasks.Promise<TransactionToken> {
        const pendingTrans: PendingTransaction = {
            storeNames,
            exclusive,
            openDefer: SyncTasks.Defer<TransactionToken>()
        };

        this._pendingTransactions.push(pendingTrans);

        this._checkNextTransactions();

        return pendingTrans.openDefer.promise();
    }

    transactionComplete(token: TransactionToken) {
        const tokenInt = token as TransactionTokenInternal;
        if (tokenInt.completionDefer) {
            const toResolve = tokenInt.completionDefer;
            tokenInt.completionDefer = undefined;
            toResolve.resolve();
        } else {
            throw new Error('Completing a transaction that has already been completed');
        }

        this._cleanTransaction(token);
    }

    transactionFailed(token: TransactionToken, message: string) {
        const tokenInt = token as TransactionTokenInternal;
        if (tokenInt.completionDefer) {
            const toResolve = tokenInt.completionDefer;
            tokenInt.completionDefer = undefined;
            toResolve.reject(new Error(message));
        } else {
            throw new Error('Failing a transaction that has already been completed');
        }

        this._cleanTransaction(token);
    }

    private _cleanTransaction(token: TransactionToken) {
        if (token.exclusive) {
            _.each(token.storeNames, storeName => {
                assert.ok(this._exclusiveLocks[storeName], 'Missing expected exclusive lock for store: ' + storeName);
                this._exclusiveLocks[storeName] = false;
            });
        } else {
            _.each(token.storeNames, storeName => {
                assert.ok(this._readOnlyCounts[storeName] > 0, 'Missing expected readonly lock for store: ' + storeName);
                this._readOnlyCounts[storeName]--;
            });
        }

        this._checkNextTransactions();
    }

    private _checkNextTransactions(): void {
        for (let i = 0; i < this._pendingTransactions.length; ) {
            const trans = this._pendingTransactions[i];

            if (this._closingDefer) {
                this._pendingTransactions.splice(i, 1);
                trans.openDefer.reject('Closing Provider');   
                continue;             
            }

            if (trans.exclusive && !this._supportsDiscreteTransactions && _.some(this._exclusiveLocks, lock => lock) ||
                    _.some(trans.storeNames, storeName => this._exclusiveLocks[storeName] ||
                        (trans.exclusive && this._readOnlyCounts[storeName] > 0))) {
                i++;
                continue;
            }

            this._pendingTransactions.splice(i, 1);

            if (trans.exclusive) {
                _.each(trans.storeNames, storeName => {
                    this._exclusiveLocks[storeName] = true;
                });
            } else {
                _.each(trans.storeNames, storeName => {
                    this._readOnlyCounts[storeName]++;
                });
            }

            const newDefer = SyncTasks.Defer<void>();
            const newToken: TransactionTokenInternal = {
                completionDefer: newDefer,
                completionPromise: newDefer.promise(),
                exclusive: trans.exclusive,
                storeNames: trans.storeNames
            };

            trans.openDefer.resolve(newToken);
        }

        this._checkClose();
    }
}

export default TransactionLockHelper;
