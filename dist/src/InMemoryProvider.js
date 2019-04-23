"use strict";
/**
 * InMemoryProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for a non-persisted in-memory database backing provider.
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    }
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
var lodash_1 = require("lodash");
var FullTextSearchHelpers_1 = require("./FullTextSearchHelpers");
var NoSqlProvider_1 = require("./NoSqlProvider");
var NoSqlProviderUtils_1 = require("./NoSqlProviderUtils");
var TransactionLockHelper_1 = require("./TransactionLockHelper");
// Very simple in-memory dbprovider for handling IE inprivate windows (and unit tests, maybe?)
var InMemoryProvider = /** @class */ (function (_super) {
    __extends(InMemoryProvider, _super);
    function InMemoryProvider() {
        var _this = _super !== null && _super.apply(this, arguments) || this;
        _this._stores = {};
        return _this;
    }
    InMemoryProvider.prototype.open = function (dbName, schema, wipeIfExists, verbose) {
        var _this = this;
        _super.prototype.open.call(this, dbName, schema, wipeIfExists, verbose);
        lodash_1.each(this._schema.stores, function (storeSchema) {
            _this._stores[storeSchema.name] = { schema: storeSchema, data: {} };
        });
        this._lockHelper = new TransactionLockHelper_1.TransactionLockHelper(schema, true);
        return Promise.resolve(void 0);
    };
    InMemoryProvider.prototype._deleteDatabaseInternal = function () {
        return Promise.resolve();
    };
    InMemoryProvider.prototype.openTransaction = function (storeNames, writeNeeded) {
        var _this = this;
        return this._lockHelper.openTransaction(storeNames, writeNeeded).then(function (token) {
            return new InMemoryTransaction(_this, _this._lockHelper, token);
        });
    };
    InMemoryProvider.prototype.close = function () {
        var _this = this;
        return this._lockHelper.closeWhenPossible().then(function () {
            _this._stores = {};
        });
    };
    InMemoryProvider.prototype.internal_getStore = function (name) {
        return this._stores[name];
    };
    return InMemoryProvider;
}(NoSqlProvider_1.DbProvider));
exports.InMemoryProvider = InMemoryProvider;
// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
var InMemoryTransaction = /** @class */ (function () {
    function InMemoryTransaction(_prov, _lockHelper, _transToken) {
        var _this = this;
        this._prov = _prov;
        this._lockHelper = _lockHelper;
        this._transToken = _transToken;
        this._stores = {};
        // Close the transaction on the next tick.  By definition, anything is completed synchronously here, so after an event tick
        // goes by, there can't have been anything pending.
        this._openTimer = setTimeout(function () {
            _this._openTimer = undefined;
            _this._commitTransaction();
            _this._lockHelper.transactionComplete(_this._transToken);
        }, 0);
    }
    InMemoryTransaction.prototype._commitTransaction = function () {
        lodash_1.each(this._stores, function (store) {
            store.internal_commitPendingData();
        });
    };
    InMemoryTransaction.prototype.getCompletionPromise = function () {
        return this._transToken.completionPromise;
    };
    InMemoryTransaction.prototype.abort = function () {
        lodash_1.each(this._stores, function (store) {
            store.internal_rollbackPendingData();
        });
        this._stores = {};
        if (this._openTimer) {
            clearTimeout(this._openTimer);
            this._openTimer = undefined;
        }
        this._lockHelper.transactionFailed(this._transToken, 'InMemoryTransaction Aborted');
    };
    InMemoryTransaction.prototype.markCompleted = function () {
        // noop
    };
    InMemoryTransaction.prototype.getStore = function (storeName) {
        if (!lodash_1.includes(NoSqlProviderUtils_1.arrayify(this._transToken.storeNames), storeName)) {
            throw new Error('Store not found in transaction-scoped store list: ' + storeName);
        }
        if (this._stores[storeName]) {
            return this._stores[storeName];
        }
        var store = this._prov.internal_getStore(storeName);
        if (!store) {
            throw new Error('Store not found: ' + storeName);
        }
        var ims = new InMemoryStore(this, store);
        this._stores[storeName] = ims;
        return ims;
    };
    InMemoryTransaction.prototype.internal_isOpen = function () {
        return !!this._openTimer;
    };
    return InMemoryTransaction;
}());
var InMemoryStore = /** @class */ (function () {
    function InMemoryStore(_trans, storeInfo) {
        this._trans = _trans;
        this._storeSchema = storeInfo.schema;
        this._committedStoreData = storeInfo.data;
        this._mergedData = this._committedStoreData;
    }
    InMemoryStore.prototype._checkDataClone = function () {
        if (!this._pendingCommitDataChanges) {
            this._pendingCommitDataChanges = {};
            this._mergedData = lodash_1.assign({}, this._committedStoreData);
        }
    };
    InMemoryStore.prototype.internal_commitPendingData = function () {
        var _this = this;
        lodash_1.each(this._pendingCommitDataChanges, function (val, key) {
            if (val === undefined) {
                delete _this._committedStoreData[key];
            }
            else {
                _this._committedStoreData[key] = val;
            }
        });
        this._pendingCommitDataChanges = undefined;
        this._mergedData = this._committedStoreData;
    };
    InMemoryStore.prototype.internal_rollbackPendingData = function () {
        this._pendingCommitDataChanges = undefined;
        this._mergedData = this._committedStoreData;
    };
    InMemoryStore.prototype.get = function (key) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        var joinedKey = lodash_1.attempt(function () {
            return NoSqlProviderUtils_1.serializeKeyToString(key, _this._storeSchema.primaryKeyPath);
        });
        if (lodash_1.isError(joinedKey)) {
            return Promise.reject(joinedKey);
        }
        return Promise.resolve(this._mergedData[joinedKey]);
    };
    InMemoryStore.prototype.getMultiple = function (keyOrKeys) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        var joinedKeys = lodash_1.attempt(function () {
            return NoSqlProviderUtils_1.formListOfSerializedKeys(keyOrKeys, _this._storeSchema.primaryKeyPath);
        });
        if (lodash_1.isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }
        return Promise.resolve(lodash_1.compact(lodash_1.map(joinedKeys, function (key) { return _this._mergedData[key]; })));
    };
    InMemoryStore.prototype.put = function (itemOrItems) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        var err = lodash_1.attempt(function () {
            lodash_1.each(NoSqlProviderUtils_1.arrayify(itemOrItems), function (item) {
                var pk = NoSqlProviderUtils_1.getSerializedKeyForKeypath(item, _this._storeSchema.primaryKeyPath);
                _this._pendingCommitDataChanges[pk] = item;
                _this._mergedData[pk] = item;
            });
        });
        if (err) {
            return Promise.reject(err);
        }
        return Promise.resolve(void 0);
    };
    InMemoryStore.prototype.remove = function (keyOrKeys) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        var joinedKeys = lodash_1.attempt(function () {
            return NoSqlProviderUtils_1.formListOfSerializedKeys(keyOrKeys, _this._storeSchema.primaryKeyPath);
        });
        if (lodash_1.isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }
        return this.removeInternal(joinedKeys);
    };
    InMemoryStore.prototype.removeRange = function (indexName, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        var index = lodash_1.attempt(function () {
            return indexName ? _this.openIndex(indexName) : _this.openPrimaryKey();
        });
        if (!index || lodash_1.isError(index)) {
            return Promise.reject('Index "' + indexName + '" not found');
        }
        return index.getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).then(function (keys) {
            return _this.removeInternal(keys);
        });
    };
    InMemoryStore.prototype.openPrimaryKey = function () {
        this._checkDataClone();
        return new InMemoryIndex(this._trans, this._mergedData, undefined, this._storeSchema.primaryKeyPath);
    };
    InMemoryStore.prototype.openIndex = function (indexName) {
        var indexSchema = lodash_1.find(this._storeSchema.indexes, function (idx) { return idx.name === indexName; });
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }
        this._checkDataClone();
        return new InMemoryIndex(this._trans, this._mergedData, indexSchema, this._storeSchema.primaryKeyPath);
    };
    InMemoryStore.prototype.clearAllData = function () {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        lodash_1.each(this._mergedData, function (_val, key) {
            _this._pendingCommitDataChanges[key] = undefined;
        });
        this._mergedData = {};
        return Promise.resolve(void 0);
    };
    InMemoryStore.prototype.removeInternal = function (keys) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        lodash_1.each(keys, function (key) {
            _this._pendingCommitDataChanges[key] = undefined;
            delete _this._mergedData[key];
        });
        return Promise.resolve(void 0);
    };
    return InMemoryStore;
}());
// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
var InMemoryIndex = /** @class */ (function (_super) {
    __extends(InMemoryIndex, _super);
    function InMemoryIndex(_trans, _mergedData, indexSchema, primaryKeyPath) {
        var _this = _super.call(this, indexSchema, primaryKeyPath) || this;
        _this._trans = _trans;
        _this._mergedData = _mergedData;
        return _this;
    }
    // Warning: This function can throw, make sure to trap.
    InMemoryIndex.prototype._calcChunkedData = function () {
        var _this = this;
        if (!this._indexSchema) {
            // Primary key -- use data intact
            return this._mergedData;
        }
        // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
        var data = {};
        lodash_1.each(this._mergedData, function (item) {
            // Each item may be non-unique so store as an array of items for each key
            var keys;
            if (_this._indexSchema.fullText) {
                keys = lodash_1.map(FullTextSearchHelpers_1.getFullTextIndexWordsForItem(_this._keyPath, item), function (val) {
                    return NoSqlProviderUtils_1.serializeKeyToString(val, _this._keyPath);
                });
            }
            else if (_this._indexSchema.multiEntry) {
                // Have to extract the multiple entries into this alternate table...
                var valsRaw = NoSqlProviderUtils_1.getValueForSingleKeypath(item, _this._keyPath);
                if (valsRaw) {
                    keys = lodash_1.map(NoSqlProviderUtils_1.arrayify(valsRaw), function (val) {
                        return NoSqlProviderUtils_1.serializeKeyToString(val, _this._keyPath);
                    });
                }
            }
            else {
                keys = [NoSqlProviderUtils_1.getSerializedKeyForKeypath(item, _this._keyPath)];
            }
            lodash_1.each(keys, function (key) {
                if (!data[key]) {
                    data[key] = [item];
                }
                else {
                    data[key].push(item);
                }
            });
        });
        return data;
    };
    InMemoryIndex.prototype.getAll = function (reverseOrSortOrder, limit, offset) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        var data = lodash_1.attempt(function () {
            return _this._calcChunkedData();
        });
        if (lodash_1.isError(data)) {
            return Promise.reject(data);
        }
        var sortedKeys = lodash_1.keys(data).sort();
        return this._returnResultsFromKeys(data, sortedKeys, reverseOrSortOrder, limit, offset);
    };
    InMemoryIndex.prototype.getOnly = function (key, reverseOrSortOrder, limit, offset) {
        return this.getRange(key, key, false, false, reverseOrSortOrder, limit, offset);
    };
    InMemoryIndex.prototype.getRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        var data;
        var sortedKeys;
        var err = lodash_1.attempt(function () {
            data = _this._calcChunkedData();
            sortedKeys = _this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).sort();
        });
        if (err) {
            return Promise.reject(err);
        }
        return this._returnResultsFromKeys(data, sortedKeys, reverseOrSortOrder, limit, offset);
    };
    InMemoryIndex.prototype.getKeysForRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        var keys = lodash_1.attempt(function () {
            var data = _this._calcChunkedData();
            return _this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keys)) {
            return Promise.reject(void 0);
        }
        return Promise.resolve(keys);
    };
    // Warning: This function can throw, make sure to trap.
    InMemoryIndex.prototype._getKeysForRange = function (data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var keyLow = NoSqlProviderUtils_1.serializeKeyToString(keyLowRange, this._keyPath);
        var keyHigh = NoSqlProviderUtils_1.serializeKeyToString(keyHighRange, this._keyPath);
        return lodash_1.filter(lodash_1.keys(data), function (key) {
            return (key > keyLow || (key === keyLow && !lowRangeExclusive)) && (key < keyHigh || (key === keyHigh && !highRangeExclusive));
        });
    };
    InMemoryIndex.prototype._returnResultsFromKeys = function (data, sortedKeys, reverseOrSortOrder, limit, offset) {
        if (reverseOrSortOrder === true || reverseOrSortOrder === NoSqlProvider_1.QuerySortOrder.Reverse) {
            sortedKeys = lodash_1.reverse(sortedKeys);
        }
        if (offset) {
            sortedKeys = sortedKeys.slice(offset);
        }
        if (limit) {
            sortedKeys = sortedKeys.slice(0, limit);
        }
        var results = lodash_1.map(sortedKeys, function (key) { return data[key]; });
        return Promise.resolve(lodash_1.flatten(results));
    };
    InMemoryIndex.prototype.countAll = function () {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        var data = lodash_1.attempt(function () {
            return _this._calcChunkedData();
        });
        if (lodash_1.isError(data)) {
            return Promise.reject(data);
        }
        return Promise.resolve(lodash_1.keys(data).length);
    };
    InMemoryIndex.prototype.countOnly = function (key) {
        return this.countRange(key, key, false, false);
    };
    InMemoryIndex.prototype.countRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        var keys = lodash_1.attempt(function () {
            var data = _this._calcChunkedData();
            return _this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keys)) {
            return Promise.reject(keys);
        }
        return Promise.resolve(keys.length);
    };
    return InMemoryIndex;
}(FullTextSearchHelpers_1.DbIndexFTSFromRangeQueries));
//# sourceMappingURL=InMemoryProvider.js.map