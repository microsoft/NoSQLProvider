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

class TransactionLockHelper {
    private _closingDefer: SyncTasks.Deferred<void>;
    private _closed = false;

    private _exclusiveLocks: _.Dictionary<boolean> = {};
    private _readOnlyCounts: _.Dictionary<number> = {};

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

        const completionDefer = SyncTasks.Defer<void>();
        const newToken: TransactionToken = {
            // Undefined means lock all stores
            storeNames: storeNames || _.map(this._schema.stores, store => store.name),
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
        const pendingTransIndex = _.findIndex(this._pendingTransactions, trans => trans.token === token);
        if (pendingTransIndex !== -1) {
            const pendingTrans = this._pendingTransactions[pendingTransIndex];
            if (pendingTrans.completionDefer) {
                pendingTrans.hadSuccess = true;

                const toResolve = pendingTrans.completionDefer;
                this._pendingTransactions.splice(pendingTransIndex, 1);
                pendingTrans.completionDefer = undefined;
                toResolve.resolve();
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
        const pendingTransIndex = _.findIndex(this._pendingTransactions, trans => trans.token === token);
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

            if (trans.opened) {
                i++;
                continue;
            }

            if (this._closingDefer) {
                this._pendingTransactions.splice(i, 1);
                trans.openDefer.reject('Closing Provider');
                continue;
            }

            if (_.some(trans.token.storeNames, storeName => this._exclusiveLocks[storeName] ||
                    (trans.token.exclusive && this._readOnlyCounts[storeName] > 0))) {
                i++;
                continue;
            }

            trans.opened = true;

            if (trans.token.exclusive) {
                _.each(trans.token.storeNames, storeName => {
                    this._exclusiveLocks[storeName] = true;
                });
            } else {
                _.each(trans.token.storeNames, storeName => {
                    this._readOnlyCounts[storeName]++;
                });
            }

            trans.openDefer.resolve(trans.token);
        }

        this._checkClose();
    }
}

export default TransactionLockHelper;
