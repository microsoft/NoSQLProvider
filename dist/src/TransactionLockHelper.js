"use strict";
/**
 * TransactionLockHelper.ts
 * Author: David de Regt
 * Copyright: Microsoft 2017
 *
 * Several of the different providers need various types of help enforcing exclusive/readonly transactions.  This helper keeps
 * store-specific lock info and releases transactions at the right time, when the underlying provider can't handle it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = require("assert");
const lodash_1 = require("lodash");
class Deferred {
    constructor() {
        this._reject = undefined;
        this._resolve = undefined;
        this._promise = new Promise((resolve, reject) => {
            this._reject = reject;
            this._resolve = resolve;
        });
    }
    get promise() {
        return this._promise;
    }
    resolve(value) {
        return this._resolve(value);
    }
    reject(reason) {
        return this._reject(reason);
    }
}
class TransactionLockHelper {
    constructor(_schema, _supportsDiscreteTransactions) {
        this._schema = _schema;
        this._supportsDiscreteTransactions = _supportsDiscreteTransactions;
        this._closed = false;
        this._exclusiveLocks = {};
        this._readOnlyCounts = {};
        this._pendingTransactions = [];
        lodash_1.each(this._schema.stores, store => {
            this._exclusiveLocks[store.name] = false;
            this._readOnlyCounts[store.name] = 0;
        });
    }
    closeWhenPossible() {
        if (!this._closingDefer) {
            this._closingDefer = new Deferred();
            this._checkClose();
        }
        return this._closingDefer.promise;
    }
    _checkClose() {
        if (!this._closed && this._closingDefer && !this.hasTransaction()) {
            this._closed = true;
            this._closingDefer.resolve(void 0);
        }
    }
    hasTransaction() {
        return this._pendingTransactions.length > 0 ||
            lodash_1.some(this._exclusiveLocks, (value) => value) ||
            lodash_1.some(this._readOnlyCounts, (value) => value > 0);
    }
    openTransaction(storeNames, exclusive) {
        if (storeNames) {
            const missingStore = lodash_1.find(storeNames, name => !lodash_1.some(this._schema.stores, store => name === store.name));
            if (missingStore) {
                return Promise.reject('Opened a transaction with a store name (' + missingStore + ') not defined in your schema!');
            }
        }
        const completionDefer = new Deferred();
        const newToken = {
            // Undefined means lock all stores
            storeNames: storeNames || lodash_1.map(this._schema.stores, store => store.name),
            exclusive,
            completionPromise: completionDefer.promise
        };
        const pendingTrans = {
            token: newToken,
            opened: false,
            openDefer: new Deferred(),
            completionDefer
        };
        this._pendingTransactions.push(pendingTrans);
        this._checkNextTransactions();
        return pendingTrans.openDefer.promise;
    }
    transactionComplete(token) {
        const pendingTransIndex = lodash_1.findIndex(this._pendingTransactions, trans => trans.token === token);
        if (pendingTransIndex !== -1) {
            const pendingTrans = this._pendingTransactions[pendingTransIndex];
            if (pendingTrans.completionDefer) {
                pendingTrans.hadSuccess = true;
                const toResolve = pendingTrans.completionDefer;
                this._pendingTransactions.splice(pendingTransIndex, 1);
                pendingTrans.completionDefer = undefined;
                toResolve.resolve(void 0);
            }
            else {
                throw new Error('Completing a transaction that has already been completed. Stores: ' + token.storeNames.join(',') +
                    ', HadSuccess: ' + pendingTrans.hadSuccess);
            }
        }
        else {
            throw new Error('Completing a transaction that is no longer tracked. Stores: ' + token.storeNames.join(','));
        }
        this._cleanTransaction(token);
    }
    transactionFailed(token, message) {
        const pendingTransIndex = lodash_1.findIndex(this._pendingTransactions, trans => trans.token === token);
        if (pendingTransIndex !== -1) {
            const pendingTrans = this._pendingTransactions[pendingTransIndex];
            if (pendingTrans.completionDefer) {
                pendingTrans.hadSuccess = false;
                const toResolve = pendingTrans.completionDefer;
                this._pendingTransactions.splice(pendingTransIndex, 1);
                pendingTrans.completionDefer = undefined;
                toResolve.reject(new Error(message));
            }
            else {
                throw new Error('Failing a transaction that has already been completed. Stores: ' + token.storeNames.join(',') +
                    ', HadSuccess: ' + pendingTrans.hadSuccess + ', Message: ' + message);
            }
        }
        else {
            throw new Error('Failing a transaction that is no longer tracked. Stores: ' + token.storeNames.join(',') + ', message: ' +
                message);
        }
        this._cleanTransaction(token);
    }
    _cleanTransaction(token) {
        if (token.exclusive) {
            lodash_1.each(token.storeNames, storeName => {
                assert_1.ok(this._exclusiveLocks[storeName], 'Missing expected exclusive lock for store: ' + storeName);
                this._exclusiveLocks[storeName] = false;
            });
        }
        else {
            lodash_1.each(token.storeNames, storeName => {
                assert_1.ok(this._readOnlyCounts[storeName] > 0, 'Missing expected readonly lock for store: ' + storeName);
                this._readOnlyCounts[storeName]--;
            });
        }
        this._checkNextTransactions();
    }
    _checkNextTransactions() {
        if (lodash_1.some(this._exclusiveLocks, lock => lock) && !this._supportsDiscreteTransactions) {
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
            if (lodash_1.some(trans.token.storeNames, storeName => this._exclusiveLocks[storeName] ||
                (trans.token.exclusive && this._readOnlyCounts[storeName] > 0))) {
                i++;
                continue;
            }
            trans.opened = true;
            if (trans.token.exclusive) {
                lodash_1.each(trans.token.storeNames, storeName => {
                    this._exclusiveLocks[storeName] = true;
                });
            }
            else {
                lodash_1.each(trans.token.storeNames, storeName => {
                    this._readOnlyCounts[storeName]++;
                });
            }
            trans.openDefer.resolve(trans.token);
        }
        this._checkClose();
    }
}
exports.TransactionLockHelper = TransactionLockHelper;
//# sourceMappingURL=TransactionLockHelper.js.map