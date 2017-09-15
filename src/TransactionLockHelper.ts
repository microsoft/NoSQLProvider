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
    completionDefer: SyncTasks.Deferred<void>|undefined;
}

class TransactionLockHelper {
    private _closingDefer: SyncTasks.Deferred<void>;
    private _closed = false;

    protected _exclusiveLocks: _.Dictionary<boolean> = {};
    protected _readOnlyCounts: _.Dictionary<number> = {};

    private _pendingTransactions: PendingTransaction[] = [];
    
    constructor(private _schema: NoSqlProvider.DbSchema, private _supportsDiscreteTransactions: boolean) {
        _.each(this._schema.stores, store => {
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

    openTransaction(storeNames: string[]|undefined, exclusive: boolean): SyncTasks.Promise<TransactionToken> {
        if (storeNames) {
            const missingStore = _.find(storeNames, name => !_.some(this._schema.stores, store => name === store.name));
            if (missingStore) {
                return SyncTasks.Rejected('Opened a transaction with a store name (' + missingStore + ') not defined in your schema!');
            }
        }

        const pendingTrans: PendingTransaction = {
            // Undefined means lock all stores
            storeNames: storeNames || _.map(this._schema.stores, store => store.name),
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
        if (_.some(this._exclusiveLocks, lock => lock) && !this._supportsDiscreteTransactions) {
            // In these cases, no more transactions will be possible.  Break out early.
            return;
        }

        for (let i = 0; i < this._pendingTransactions.length; ) {
            const trans = this._pendingTransactions[i];

            if (this._closingDefer) {
                this._pendingTransactions.splice(i, 1);
                trans.openDefer.reject('Closing Provider');
                continue;             
            }

            if (_.some(trans.storeNames, storeName => this._exclusiveLocks[storeName] ||
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
