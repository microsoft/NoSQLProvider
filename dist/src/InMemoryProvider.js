"use strict";
/**
 * InMemoryProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for a non-persisted in-memory database backing provider.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const lodash_1 = require("lodash");
const FullTextSearchHelpers_1 = require("./FullTextSearchHelpers");
const NoSqlProvider_1 = require("./NoSqlProvider");
const NoSqlProviderUtils_1 = require("./NoSqlProviderUtils");
const TransactionLockHelper_1 = require("./TransactionLockHelper");
// Very simple in-memory dbprovider for handling IE inprivate windows (and unit tests, maybe?)
class InMemoryProvider extends NoSqlProvider_1.DbProvider {
    constructor() {
        super(...arguments);
        this._stores = {};
    }
    open(dbName, schema, wipeIfExists, verbose) {
        super.open(dbName, schema, wipeIfExists, verbose);
        lodash_1.each(this._schema.stores, storeSchema => {
            this._stores[storeSchema.name] = { schema: storeSchema, data: {} };
        });
        this._lockHelper = new TransactionLockHelper_1.TransactionLockHelper(schema, true);
        return Promise.resolve(void 0);
    }
    _deleteDatabaseInternal() {
        return Promise.resolve();
    }
    openTransaction(storeNames, writeNeeded) {
        return this._lockHelper.openTransaction(storeNames, writeNeeded).then((token) => new InMemoryTransaction(this, this._lockHelper, token));
    }
    close() {
        return this._lockHelper.closeWhenPossible().then(() => {
            this._stores = {};
        });
    }
    internal_getStore(name) {
        return this._stores[name];
    }
}
exports.InMemoryProvider = InMemoryProvider;
// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
class InMemoryTransaction {
    constructor(_prov, _lockHelper, _transToken) {
        this._prov = _prov;
        this._lockHelper = _lockHelper;
        this._transToken = _transToken;
        this._stores = {};
        // Close the transaction on the next tick.  By definition, anything is completed synchronously here, so after an event tick
        // goes by, there can't have been anything pending.
        this._openTimer = setTimeout(() => {
            this._openTimer = undefined;
            this._commitTransaction();
            this._lockHelper.transactionComplete(this._transToken);
        }, 0);
    }
    _commitTransaction() {
        lodash_1.each(this._stores, store => {
            store.internal_commitPendingData();
        });
    }
    getCompletionPromise() {
        return this._transToken.completionPromise;
    }
    abort() {
        lodash_1.each(this._stores, store => {
            store.internal_rollbackPendingData();
        });
        this._stores = {};
        if (this._openTimer) {
            clearTimeout(this._openTimer);
            this._openTimer = undefined;
        }
        this._lockHelper.transactionFailed(this._transToken, 'InMemoryTransaction Aborted');
    }
    markCompleted() {
        // noop
    }
    getStore(storeName) {
        if (!lodash_1.includes(NoSqlProviderUtils_1.arrayify(this._transToken.storeNames), storeName)) {
            throw new Error('Store not found in transaction-scoped store list: ' + storeName);
        }
        if (this._stores[storeName]) {
            return this._stores[storeName];
        }
        const store = this._prov.internal_getStore(storeName);
        if (!store) {
            throw new Error('Store not found: ' + storeName);
        }
        const ims = new InMemoryStore(this, store);
        this._stores[storeName] = ims;
        return ims;
    }
    internal_isOpen() {
        return !!this._openTimer;
    }
}
class InMemoryStore {
    constructor(_trans, storeInfo) {
        this._trans = _trans;
        this._storeSchema = storeInfo.schema;
        this._committedStoreData = storeInfo.data;
        this._mergedData = this._committedStoreData;
    }
    _checkDataClone() {
        if (!this._pendingCommitDataChanges) {
            this._pendingCommitDataChanges = {};
            this._mergedData = lodash_1.assign({}, this._committedStoreData);
        }
    }
    internal_commitPendingData() {
        lodash_1.each(this._pendingCommitDataChanges, (val, key) => {
            if (val === undefined) {
                delete this._committedStoreData[key];
            }
            else {
                this._committedStoreData[key] = val;
            }
        });
        this._pendingCommitDataChanges = undefined;
        this._mergedData = this._committedStoreData;
    }
    internal_rollbackPendingData() {
        this._pendingCommitDataChanges = undefined;
        this._mergedData = this._committedStoreData;
    }
    get(key) {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        const joinedKey = lodash_1.attempt(() => {
            return NoSqlProviderUtils_1.serializeKeyToString(key, this._storeSchema.primaryKeyPath);
        });
        if (lodash_1.isError(joinedKey)) {
            return Promise.reject(joinedKey);
        }
        return Promise.resolve(this._mergedData[joinedKey]);
    }
    getMultiple(keyOrKeys) {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        const joinedKeys = lodash_1.attempt(() => {
            return NoSqlProviderUtils_1.formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (lodash_1.isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }
        return Promise.resolve(lodash_1.compact(lodash_1.map(joinedKeys, key => this._mergedData[key])));
    }
    put(itemOrItems) {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        const err = lodash_1.attempt(() => {
            lodash_1.each(NoSqlProviderUtils_1.arrayify(itemOrItems), item => {
                let pk = NoSqlProviderUtils_1.getSerializedKeyForKeypath(item, this._storeSchema.primaryKeyPath);
                this._pendingCommitDataChanges[pk] = item;
                this._mergedData[pk] = item;
            });
        });
        if (err) {
            return Promise.reject(err);
        }
        return Promise.resolve(void 0);
    }
    remove(keyOrKeys) {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        const joinedKeys = lodash_1.attempt(() => {
            return NoSqlProviderUtils_1.formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (lodash_1.isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }
        return this.removeInternal(joinedKeys);
    }
    removeRange(indexName, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        const index = lodash_1.attempt(() => {
            return indexName ? this.openIndex(indexName) : this.openPrimaryKey();
        });
        if (!index || lodash_1.isError(index)) {
            return Promise.reject('Index "' + indexName + '" not found');
        }
        return index.getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).then(keys => {
            return this.removeInternal(keys);
        });
    }
    openPrimaryKey() {
        this._checkDataClone();
        return new InMemoryIndex(this._trans, this._mergedData, undefined, this._storeSchema.primaryKeyPath);
    }
    openIndex(indexName) {
        let indexSchema = lodash_1.find(this._storeSchema.indexes, idx => idx.name === indexName);
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }
        this._checkDataClone();
        return new InMemoryIndex(this._trans, this._mergedData, indexSchema, this._storeSchema.primaryKeyPath);
    }
    clearAllData() {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        lodash_1.each(this._mergedData, (_val, key) => {
            this._pendingCommitDataChanges[key] = undefined;
        });
        this._mergedData = {};
        return Promise.resolve(void 0);
    }
    removeInternal(keys) {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        lodash_1.each(keys, key => {
            this._pendingCommitDataChanges[key] = undefined;
            delete this._mergedData[key];
        });
        return Promise.resolve(void 0);
    }
}
// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
class InMemoryIndex extends FullTextSearchHelpers_1.DbIndexFTSFromRangeQueries {
    constructor(_trans, _mergedData, indexSchema, primaryKeyPath) {
        super(indexSchema, primaryKeyPath);
        this._trans = _trans;
        this._mergedData = _mergedData;
    }
    // Warning: This function can throw, make sure to trap.
    _calcChunkedData() {
        if (!this._indexSchema) {
            // Primary key -- use data intact
            return this._mergedData;
        }
        // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
        let data = {};
        lodash_1.each(this._mergedData, item => {
            // Each item may be non-unique so store as an array of items for each key
            let keys;
            if (this._indexSchema.fullText) {
                keys = lodash_1.map(FullTextSearchHelpers_1.getFullTextIndexWordsForItem(this._keyPath, item), val => NoSqlProviderUtils_1.serializeKeyToString(val, this._keyPath));
            }
            else if (this._indexSchema.multiEntry) {
                // Have to extract the multiple entries into this alternate table...
                const valsRaw = NoSqlProviderUtils_1.getValueForSingleKeypath(item, this._keyPath);
                if (valsRaw) {
                    keys = lodash_1.map(NoSqlProviderUtils_1.arrayify(valsRaw), val => NoSqlProviderUtils_1.serializeKeyToString(val, this._keyPath));
                }
            }
            else {
                keys = [NoSqlProviderUtils_1.getSerializedKeyForKeypath(item, this._keyPath)];
            }
            lodash_1.each(keys, key => {
                if (!data[key]) {
                    data[key] = [item];
                }
                else {
                    data[key].push(item);
                }
            });
        });
        return data;
    }
    getAll(reverseOrSortOrder, limit, offset) {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        const data = lodash_1.attempt(() => {
            return this._calcChunkedData();
        });
        if (lodash_1.isError(data)) {
            return Promise.reject(data);
        }
        const sortedKeys = lodash_1.keys(data).sort();
        return this._returnResultsFromKeys(data, sortedKeys, reverseOrSortOrder, limit, offset);
    }
    getOnly(key, reverseOrSortOrder, limit, offset) {
        return this.getRange(key, key, false, false, reverseOrSortOrder, limit, offset);
    }
    getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset) {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        let data;
        let sortedKeys;
        const err = lodash_1.attempt(() => {
            data = this._calcChunkedData();
            sortedKeys = this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).sort();
        });
        if (err) {
            return Promise.reject(err);
        }
        return this._returnResultsFromKeys(data, sortedKeys, reverseOrSortOrder, limit, offset);
    }
    getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        const keys = lodash_1.attempt(() => {
            const data = this._calcChunkedData();
            return this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keys)) {
            return Promise.reject(void 0);
        }
        return Promise.resolve(keys);
    }
    // Warning: This function can throw, make sure to trap.
    _getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        const keyLow = NoSqlProviderUtils_1.serializeKeyToString(keyLowRange, this._keyPath);
        const keyHigh = NoSqlProviderUtils_1.serializeKeyToString(keyHighRange, this._keyPath);
        return lodash_1.filter(lodash_1.keys(data), key => (key > keyLow || (key === keyLow && !lowRangeExclusive)) && (key < keyHigh || (key === keyHigh && !highRangeExclusive)));
    }
    _returnResultsFromKeys(data, sortedKeys, reverseOrSortOrder, limit, offset) {
        if (reverseOrSortOrder === true || reverseOrSortOrder === NoSqlProvider_1.QuerySortOrder.Reverse) {
            sortedKeys = lodash_1.reverse(sortedKeys);
        }
        if (offset) {
            sortedKeys = sortedKeys.slice(offset);
        }
        if (limit) {
            sortedKeys = sortedKeys.slice(0, limit);
        }
        let results = lodash_1.map(sortedKeys, key => data[key]);
        return Promise.resolve(lodash_1.flatten(results));
    }
    countAll() {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        const data = lodash_1.attempt(() => {
            return this._calcChunkedData();
        });
        if (lodash_1.isError(data)) {
            return Promise.reject(data);
        }
        return Promise.resolve(lodash_1.keys(data).length);
    }
    countOnly(key) {
        return this.countRange(key, key, false, false);
    }
    countRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        const keys = lodash_1.attempt(() => {
            const data = this._calcChunkedData();
            return this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keys)) {
            return Promise.reject(keys);
        }
        return Promise.resolve(keys.length);
    }
}
//# sourceMappingURL=InMemoryProvider.js.map