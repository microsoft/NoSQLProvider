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
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __values = (this && this.__values) || function (o) {
    var m = typeof Symbol === "function" && o[Symbol.iterator], i = 0;
    if (m) return m.call(o);
    return {
        next: function () {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
        }
    };
};
Object.defineProperty(exports, "__esModule", { value: true });
var lodash_1 = require("lodash");
var FullTextSearchHelpers_1 = require("./FullTextSearchHelpers");
var NoSqlProvider_1 = require("./NoSqlProvider");
var NoSqlProviderUtils_1 = require("./NoSqlProviderUtils");
var TransactionLockHelper_1 = require("./TransactionLockHelper");
var red_black_tree_1 = require("@collectable/red-black-tree");
// Very simple in-memory dbprov ider for handling IE inprivate windows (and unit tests, maybe?)
var InMemoryProvider = /** @class */ (function (_super) {
    __extends(InMemoryProvider, _super);
    function InMemoryProvider() {
        var _this = _super !== null && _super.apply(this, arguments) || this;
        _this._stores = new Map();
        return _this;
    }
    InMemoryProvider.prototype.open = function (dbName, schema, wipeIfExists, verbose) {
        var _this = this;
        _super.prototype.open.call(this, dbName, schema, wipeIfExists, verbose);
        lodash_1.each(this._schema.stores, function (storeSchema) {
            _this._stores.set(storeSchema.name, { schema: storeSchema, data: new Map(), indices: new Map() });
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
            return new InMemoryTransaction(_this, _this._lockHelper, token, writeNeeded);
        });
    };
    InMemoryProvider.prototype.close = function () {
        var _this = this;
        return this._lockHelper.closeWhenPossible().then(function () {
            _this._stores = new Map();
        });
    };
    InMemoryProvider.prototype.internal_getStore = function (name) {
        return this._stores.get(name);
    };
    return InMemoryProvider;
}(NoSqlProvider_1.DbProvider));
exports.InMemoryProvider = InMemoryProvider;
// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
var InMemoryTransaction = /** @class */ (function () {
    function InMemoryTransaction(_prov, _lockHelper, _transToken, writeNeeded) {
        var _this = this;
        this._prov = _prov;
        this._lockHelper = _lockHelper;
        this._transToken = _transToken;
        this._stores = new Map();
        // Close the transaction on the next tick.  By definition, anything is completed synchronously here, so after an event tick
        // goes by, there can't have been anything pending.
        if (writeNeeded) {
            this._openTimer = setTimeout(function () {
                _this._openTimer = undefined;
                _this._commitTransaction();
                _this._lockHelper.transactionComplete(_this._transToken);
            }, 0);
        }
        else {
            this._openTimer = undefined;
            this._commitTransaction();
            this._lockHelper.transactionComplete(this._transToken);
        }
    }
    InMemoryTransaction.prototype._commitTransaction = function () {
        this._stores.forEach(function (store) {
            store.internal_commitPendingData();
        });
    };
    InMemoryTransaction.prototype.getCompletionPromise = function () {
        return this._transToken.completionPromise;
    };
    InMemoryTransaction.prototype.abort = function () {
        this._stores.forEach(function (store) {
            store.internal_rollbackPendingData();
        });
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
        if (this._stores.has(storeName)) {
            return this._stores.get(storeName);
        }
        var store = this._prov.internal_getStore(storeName);
        if (!store) {
            throw new Error('Store not found: ' + storeName);
        }
        var ims = new InMemoryStore(this, store);
        this._stores.set(storeName, ims);
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
        this._committedStoreData = new Map(storeInfo.data);
        this._indices = storeInfo.indices;
        this._mergedData = storeInfo.data;
    }
    InMemoryStore.prototype.internal_commitPendingData = function () {
        this._committedStoreData = new Map(this._mergedData);
        // Indices were already updated, theres no need to update them now. 
    };
    InMemoryStore.prototype.internal_rollbackPendingData = function () {
        var _this = this;
        this._mergedData.clear();
        this._committedStoreData.forEach(function (val, key) {
            _this._mergedData.set(key, val);
        });
        // Recreate all indexes on a roll back.
        lodash_1.each(this._storeSchema.indexes, function (index) {
            _this._indices.set(index.name, new InMemoryIndex(_this._mergedData, index, _this._storeSchema.primaryKeyPath));
        });
    };
    InMemoryStore.prototype.get = function (key) {
        var _this = this;
        var joinedKey = lodash_1.attempt(function () {
            return NoSqlProviderUtils_1.serializeKeyToString(key, _this._storeSchema.primaryKeyPath);
        });
        if (lodash_1.isError(joinedKey)) {
            return Promise.reject(joinedKey);
        }
        return Promise.resolve(this._mergedData.get(joinedKey));
    };
    InMemoryStore.prototype.getMultiple = function (keyOrKeys) {
        var _this = this;
        var joinedKeys = lodash_1.attempt(function () {
            return NoSqlProviderUtils_1.formListOfSerializedKeys(keyOrKeys, _this._storeSchema.primaryKeyPath);
        });
        if (lodash_1.isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }
        return Promise.resolve(lodash_1.compact(lodash_1.map(joinedKeys, function (key) { return _this._mergedData.get(key); })));
    };
    InMemoryStore.prototype.put = function (itemOrItems) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        var err = lodash_1.attempt(function () {
            lodash_1.each(NoSqlProviderUtils_1.arrayify(itemOrItems), function (item) {
                var e_1, _a;
                var pk = NoSqlProviderUtils_1.getSerializedKeyForKeypath(item, _this._storeSchema.primaryKeyPath);
                var existingItem = _this._mergedData.get(pk);
                if (existingItem) {
                    _this._removeFromIndices(pk, existingItem);
                }
                _this._mergedData.set(pk, item);
                _this.openPrimaryKey().put(item);
                if (_this._storeSchema.indexes) {
                    try {
                        for (var _b = __values(_this._storeSchema.indexes), _c = _b.next(); !_c.done; _c = _b.next()) {
                            var index = _c.value;
                            _this.openIndex(index.name).put(item);
                        }
                    }
                    catch (e_1_1) { e_1 = { error: e_1_1 }; }
                    finally {
                        try {
                            if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
                        }
                        finally { if (e_1) throw e_1.error; }
                    }
                }
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
        var joinedKeys = lodash_1.attempt(function () {
            return NoSqlProviderUtils_1.formListOfSerializedKeys(keyOrKeys, _this._storeSchema.primaryKeyPath);
        });
        if (lodash_1.isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }
        return this._removeInternal(joinedKeys);
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
            return _this._removeInternal(keys);
        });
    };
    InMemoryStore.prototype.openPrimaryKey = function () {
        if (!this._indices.get('pk')) {
            this._indices.set('pk', new InMemoryIndex(this._mergedData, undefined, this._storeSchema.primaryKeyPath));
        }
        var index = this._indices.get('pk');
        index.internal_SetTransaction(this._trans);
        return index;
    };
    InMemoryStore.prototype.openIndex = function (indexName) {
        var indexSchema = lodash_1.find(this._storeSchema.indexes, function (idx) { return idx.name === indexName; });
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }
        if (!this._indices.has(indexSchema.name)) {
            this._indices.set(indexSchema.name, new InMemoryIndex(this._mergedData, indexSchema, this._storeSchema.primaryKeyPath));
        }
        var index = this._indices.get(indexSchema.name);
        index.internal_SetTransaction(this._trans);
        return index;
    };
    InMemoryStore.prototype.clearAllData = function () {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        this._mergedData = new Map();
        lodash_1.each(this._storeSchema.indexes, function (index) {
            _this._indices.set(index.name, new InMemoryIndex(_this._mergedData, index, _this._storeSchema.primaryKeyPath));
        });
        return Promise.resolve(void 0);
    };
    InMemoryStore.prototype._removeInternal = function (keys) {
        var _this = this;
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        lodash_1.each(keys, function (key) {
            var existingItem = _this._mergedData.get(key);
            _this._mergedData.delete(key);
            if (existingItem) {
                _this._removeFromIndices(key, existingItem);
            }
        });
        return Promise.resolve(void 0);
    };
    InMemoryStore.prototype._removeFromIndices = function (key, item) {
        var _this = this;
        this.openPrimaryKey().remove(key);
        lodash_1.each(this._storeSchema.indexes, function (index) {
            var ind = _this.openIndex(index.name);
            var keys = ind.internal_getKeysFromItem(item);
            lodash_1.each(keys, function (key) { return ind.remove(key); });
        });
    };
    return InMemoryStore;
}());
// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
var InMemoryIndex = /** @class */ (function (_super) {
    __extends(InMemoryIndex, _super);
    function InMemoryIndex(_mergedData, indexSchema, primaryKeyPath) {
        var _this = _super.call(this, indexSchema, primaryKeyPath) || this;
        _this._rbIndex = red_black_tree_1.empty(function (a, b) { return (a < b ? -1 : (a > b ? 1 : 0)); }, true);
        _this.put(lodash_1.values(_mergedData), true);
        return _this;
    }
    InMemoryIndex.prototype.internal_SetTransaction = function (trans) {
        this._trans = trans;
    };
    InMemoryIndex.prototype.internal_getKeysFromItem = function (item) {
        var _this = this;
        var keys;
        if (this._indexSchema && this._indexSchema.fullText) {
            keys = lodash_1.map(FullTextSearchHelpers_1.getFullTextIndexWordsForItem(this._keyPath, item), function (val) {
                return NoSqlProviderUtils_1.serializeKeyToString(val, _this._keyPath);
            });
        }
        else if (this._indexSchema && this._indexSchema.multiEntry) {
            // Have to extract the multiple entries into this alternate table...
            var valsRaw = NoSqlProviderUtils_1.getValueForSingleKeypath(item, this._keyPath);
            if (valsRaw) {
                keys = lodash_1.map(NoSqlProviderUtils_1.arrayify(valsRaw), function (val) {
                    return NoSqlProviderUtils_1.serializeKeyToString(val, _this._keyPath);
                });
            }
        }
        else {
            keys = [NoSqlProviderUtils_1.getSerializedKeyForKeypath(item, this._keyPath)];
        }
        return keys;
    };
    // Warning: This function can throw, make sure to trap.
    InMemoryIndex.prototype.put = function (itemOrItems, skipTransactionOnCreation) {
        var _this = this;
        if (!skipTransactionOnCreation && !this._trans.internal_isOpen()) {
            throw new Error('InMemoryTransaction already closed');
        }
        var items = NoSqlProviderUtils_1.arrayify(itemOrItems);
        // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
        lodash_1.each(items, function (item) {
            // Each item may be non-unique so store as an array of items for each key
            var keys = _this.internal_getKeysFromItem(item);
            lodash_1.each(keys, function (key) {
                if (red_black_tree_1.has(key, _this._rbIndex)) {
                    var existingItems = red_black_tree_1.get(key, _this._rbIndex);
                    existingItems.push(item);
                    red_black_tree_1.set(key, existingItems, _this._rbIndex);
                }
                else {
                    red_black_tree_1.set(key, [item], _this._rbIndex);
                }
            });
        });
    };
    InMemoryIndex.prototype.getMultiple = function (keyOrKeys) {
        var _this = this;
        var e_2, _a;
        var joinedKeys = lodash_1.attempt(function () {
            return NoSqlProviderUtils_1.formListOfSerializedKeys(keyOrKeys, _this._keyPath);
        });
        if (lodash_1.isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }
        var values = [];
        try {
            for (var joinedKeys_1 = __values(joinedKeys), joinedKeys_1_1 = joinedKeys_1.next(); !joinedKeys_1_1.done; joinedKeys_1_1 = joinedKeys_1.next()) {
                var key = joinedKeys_1_1.value;
                values.push(red_black_tree_1.get(key, this._rbIndex));
            }
        }
        catch (e_2_1) { e_2 = { error: e_2_1 }; }
        finally {
            try {
                if (joinedKeys_1_1 && !joinedKeys_1_1.done && (_a = joinedKeys_1.return)) _a.call(joinedKeys_1);
            }
            finally { if (e_2) throw e_2.error; }
        }
        return Promise.resolve(lodash_1.compact(lodash_1.flatten(values)));
    };
    InMemoryIndex.prototype.remove = function (key, skipTransactionOnCreation) {
        if (!skipTransactionOnCreation && !this._trans.internal_isOpen()) {
            throw new Error('InMemoryTransaction already closed');
        }
        red_black_tree_1.remove(key, this._rbIndex);
    };
    InMemoryIndex.prototype.getAll = function (reverseOrSortOrder, limit, offset) {
        var e_3, _a;
        limit = limit ? limit : this._rbIndex._size;
        offset = offset ? offset : 0;
        var data = new Array(limit);
        var reverse = (reverseOrSortOrder === true || reverseOrSortOrder === NoSqlProvider_1.QuerySortOrder.Reverse);
        var iterator = red_black_tree_1.iterateFromIndex(reverse, offset, this._rbIndex);
        var i = 0;
        try {
            for (var iterator_1 = __values(iterator), iterator_1_1 = iterator_1.next(); !iterator_1_1.done; iterator_1_1 = iterator_1.next()) {
                var item = iterator_1_1.value;
                data[i] = item.value[0];
                i++;
                if (i >= limit) {
                    break;
                }
            }
        }
        catch (e_3_1) { e_3 = { error: e_3_1 }; }
        finally {
            try {
                if (iterator_1_1 && !iterator_1_1.done && (_a = iterator_1.return)) _a.call(iterator_1);
            }
            finally { if (e_3) throw e_3.error; }
        }
        return Promise.resolve(data);
    };
    InMemoryIndex.prototype.getOnly = function (key, reverseOrSortOrder, limit, offset) {
        return this.getRange(key, key, false, false, reverseOrSortOrder, limit, offset);
    };
    InMemoryIndex.prototype.getRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset) {
        var _this = this;
        var values = lodash_1.attempt(function () {
            var e_4, _a;
            var reverse = reverseOrSortOrder === true || reverseOrSortOrder === NoSqlProvider_1.QuerySortOrder.Reverse;
            limit = limit ? limit : _this._rbIndex._size;
            offset = offset ? offset : 0;
            var keyLow = NoSqlProviderUtils_1.serializeKeyToString(keyLowRange, _this._keyPath);
            var keyHigh = NoSqlProviderUtils_1.serializeKeyToString(keyHighRange, _this._keyPath);
            var iterator = reverse ? red_black_tree_1.iterateKeysFromLast(_this._rbIndex) : red_black_tree_1.iterateKeysFromFirst(_this._rbIndex);
            var values = [];
            try {
                for (var iterator_2 = __values(iterator), iterator_2_1 = iterator_2.next(); !iterator_2_1.done; iterator_2_1 = iterator_2.next()) {
                    var key = iterator_2_1.value;
                    if ((key > keyLow || (key === keyLow && !lowRangeExclusive)) &&
                        (key < keyHigh || (key === keyHigh && !highRangeExclusive))) {
                        if (offset > 0) {
                            offset--;
                            continue;
                        }
                        if (values.length >= limit) {
                            break;
                        }
                        values = values.concat(red_black_tree_1.get(key, _this._rbIndex));
                    }
                }
            }
            catch (e_4_1) { e_4 = { error: e_4_1 }; }
            finally {
                try {
                    if (iterator_2_1 && !iterator_2_1.done && (_a = iterator_2.return)) _a.call(iterator_2);
                }
                finally { if (e_4) throw e_4.error; }
            }
            return values;
        });
        if (lodash_1.isError(values)) {
            return Promise.reject(values);
        }
        return Promise.resolve(values);
    };
    InMemoryIndex.prototype.getKeysForRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var _this = this;
        var keys = lodash_1.attempt(function () {
            return _this._getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keys)) {
            return Promise.reject(void 0);
        }
        return Promise.resolve(keys);
    };
    // Warning: This function can throw, make sure to trap.
    InMemoryIndex.prototype._getKeysForRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var e_5, _a;
        var keyLow = NoSqlProviderUtils_1.serializeKeyToString(keyLowRange, this._keyPath);
        var keyHigh = NoSqlProviderUtils_1.serializeKeyToString(keyHighRange, this._keyPath);
        var iterator = red_black_tree_1.iterateKeysFromFirst(this._rbIndex);
        var keys = [];
        try {
            for (var iterator_3 = __values(iterator), iterator_3_1 = iterator_3.next(); !iterator_3_1.done; iterator_3_1 = iterator_3.next()) {
                var key = iterator_3_1.value;
                if ((key > keyLow || (key === keyLow && !lowRangeExclusive)) && (key < keyHigh || (key === keyHigh && !highRangeExclusive))) {
                    keys.push(key);
                }
            }
        }
        catch (e_5_1) { e_5 = { error: e_5_1 }; }
        finally {
            try {
                if (iterator_3_1 && !iterator_3_1.done && (_a = iterator_3.return)) _a.call(iterator_3);
            }
            finally { if (e_5) throw e_5.error; }
        }
        return keys;
    };
    InMemoryIndex.prototype.countAll = function () {
        return Promise.resolve(this._rbIndex._size);
    };
    InMemoryIndex.prototype.countOnly = function (key) {
        return this.countRange(key, key, false, false);
    };
    InMemoryIndex.prototype.countRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var _this = this;
        var keys = lodash_1.attempt(function () {
            return _this._getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keys)) {
            return Promise.reject(keys);
        }
        return Promise.resolve(keys.length);
    };
    return InMemoryIndex;
}(FullTextSearchHelpers_1.DbIndexFTSFromRangeQueries));
//# sourceMappingURL=InMemoryProvider.js.map