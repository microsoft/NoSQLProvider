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
    defer: SyncTasks.Deferred<void>;
}

class TransactionLockHelper {
    protected _exclusiveLocks: _.Dictionary<boolean> = {};
    protected _readOnlyCounts: _.Dictionary<number> = {};

    private _pendingTransactions: PendingTransaction[] = [];
    
    constructor(schema: NoSqlProvider.DbSchema) {
        _.each(schema.stores, store => {
            this._exclusiveLocks[store.name] = false;
            this._readOnlyCounts[store.name] = 0;
        });
    }

    hasTransaction(): boolean {
        return this._pendingTransactions.length > 0 ||
            _.some(this._exclusiveLocks, (value) =>  value) ||
            _.some(this._readOnlyCounts, (value) => value > 0);
    }

    checkOpenTransaction(storeNames: string[], exclusive: boolean): SyncTasks.Promise<void> {
        const pendingTrans: PendingTransaction = {
            storeNames,
            exclusive,
            defer: SyncTasks.Defer<void>()
        };

        this._pendingTransactions.push(pendingTrans);

        this._checkNextTransactions();

        return pendingTrans.defer.promise();
    }

    transactionComplete(storeNames: string[], exclusive: boolean) {
        if (exclusive) {
            _.each(storeNames, storeName => {
                assert.ok(this._exclusiveLocks[storeName], 'Missing expected exclusive lock for store: ' + storeName);
                this._exclusiveLocks[storeName] = false;
            });
        } else {
            _.each(storeNames, storeName => {
                assert.ok(this._readOnlyCounts[storeName] > 0, 'Missing expected readonly lock for store: ' + storeName);
                this._readOnlyCounts[storeName]--;
            });
        }

        this._checkNextTransactions();
    }

    private _checkNextTransactions(): void {
        let toResolve: SyncTasks.Deferred<void>[] = [];

        for (let i = 0; i < this._pendingTransactions.length; ) {
            const trans = this._pendingTransactions[i];

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

            toResolve.push(trans.defer);
        }

        _.each(toResolve, defer => {
            defer.resolve();
        });
    }
}

export default TransactionLockHelper;
