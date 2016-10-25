/**
 * InMemoryProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for a non-persisted in-memory database backing provider.
 */
"use strict";
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var _ = require('lodash');
var SyncTasks = require('synctasks');
var NoSqlProvider = require('./NoSqlProvider');
var NoSqlProviderUtils = require('./NoSqlProviderUtils');
// Very simple in-memory dbprovider for handling IE inprivate windows (and unit tests, maybe?)
var InMemoryProvider = (function (_super) {
    __extends(InMemoryProvider, _super);
    function InMemoryProvider() {
        _super.apply(this, arguments);
        this._stores = {};
    }
    InMemoryProvider.prototype.open = function (dbName, schema, wipeConfig, verbose) {
        var _this = this;
        _super.prototype.open.call(this, dbName, schema, wipeConfig, verbose);
        _.each(this._schema.stores, function (store) {
            var nStore = new InMemoryStore(store);
            _this._stores[store.name] = nStore;
        });
        return SyncTasks.Resolved();
    };
    InMemoryProvider.prototype.openTransaction = function (storeNames, writeNeeded) {
        return SyncTasks.Resolved(new InMemoryTransaction(this));
    };
    InMemoryProvider.prototype.close = function () {
        return SyncTasks.Resolved();
    };
    InMemoryProvider.prototype.getStore = function (name) {
        return this._stores[name];
    };
    return InMemoryProvider;
}(NoSqlProvider.DbProvider));
exports.InMemoryProvider = InMemoryProvider;
// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
var InMemoryTransaction = (function () {
    function InMemoryTransaction(prov) {
        this._prov = prov;
    }
    InMemoryTransaction.prototype.getStore = function (storeName) {
        return this._prov.getStore(storeName);
    };
    return InMemoryTransaction;
}());
var InMemoryStore = (function () {
    function InMemoryStore(schema) {
        this._data = {};
        this._schema = schema;
    }
    InMemoryStore.prototype.get = function (key) {
        var joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath);
        return SyncTasks.Resolved(this._data[joinedKey]);
    };
    InMemoryStore.prototype.getMultiple = function (keyOrKeys) {
        var _this = this;
        var joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        return SyncTasks.Resolved(_.compact(_.map(joinedKeys, function (key) { return _this._data[key]; })));
    };
    InMemoryStore.prototype.put = function (itemOrItems) {
        var _this = this;
        _.each(NoSqlProviderUtils.arrayify(itemOrItems), function (item) {
            var pk = NoSqlProviderUtils.getSerializedKeyForKeypath(item, _this._schema.primaryKeyPath);
            _this._data[pk] = item;
        });
        return SyncTasks.Resolved();
    };
    InMemoryStore.prototype.remove = function (keyOrKeys) {
        var _this = this;
        var joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        _.each(joinedKeys, function (key) {
            delete _this._data[key];
        });
        return SyncTasks.Resolved();
    };
    InMemoryStore.prototype.openPrimaryKey = function () {
        return new InMemoryIndex(this, this._schema.primaryKeyPath, false, true);
    };
    InMemoryStore.prototype.openIndex = function (indexName) {
        var indexSchema = _.find(this._schema.indexes, function (idx) { return idx.name === indexName; });
        if (indexSchema === void 0) {
            return null;
        }
        return new InMemoryIndex(this, indexSchema.keyPath, indexSchema.multiEntry, false);
    };
    InMemoryStore.prototype.clearAllData = function () {
        this._data = {};
        return SyncTasks.Resolved();
    };
    InMemoryStore.prototype.getData = function () {
        return this._data;
    };
    return InMemoryStore;
}());
// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
var InMemoryIndex = (function () {
    function InMemoryIndex(store, keyPath, multiEntry, pk) {
        var _this = this;
        this._keyPath = keyPath;
        // Construct the index data once
        var data = store.getData();
        if (pk) {
            this._data = data;
        }
        else {
            // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
            this._data = {};
            _.each(data, function (item) {
                // Each item may be non-unique so store as an array of items for each key
                var keys = multiEntry ?
                    _.map(NoSqlProviderUtils.arrayify(NoSqlProviderUtils.getValueForSingleKeypath(item, _this._keyPath)), function (val) {
                        return NoSqlProviderUtils.serializeKeyToString(val, _this._keyPath);
                    }) :
                    [NoSqlProviderUtils.getSerializedKeyForKeypath(item, _this._keyPath)];
                _.each(keys, function (key) {
                    if (!_this._data[key]) {
                        _this._data[key] = [item];
                    }
                    else {
                        _this._data[key].push(item);
                    }
                });
            });
        }
    }
    InMemoryIndex.prototype.getAll = function (reverse, limit, offset) {
        var sortedKeys = _.keys(this._data).sort();
        return this._returnResultsFromKeys(sortedKeys, reverse, limit, offset);
    };
    InMemoryIndex.prototype.getOnly = function (key, reverse, limit, offset) {
        return this.getRange(key, key, false, false, reverse, limit, offset);
    };
    InMemoryIndex.prototype.getRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverse, limit, offset) {
        var keyLow = NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath);
        var keyHigh = NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath);
        var sortedKeys = _.filter(_.keys(this._data), function (key) {
            return (key > keyLow || (key === keyLow && !lowRangeExclusive)) && (key < keyHigh || (key === keyHigh && !highRangeExclusive));
        }).sort();
        return this._returnResultsFromKeys(sortedKeys, reverse, limit, offset);
    };
    InMemoryIndex.prototype._returnResultsFromKeys = function (sortedKeys, reverse, limit, offset) {
        var _this = this;
        if (reverse) {
            sortedKeys = _(sortedKeys).reverse().value();
        }
        if (offset) {
            sortedKeys = sortedKeys.slice(offset);
        }
        if (limit) {
            sortedKeys = sortedKeys.slice(0, limit);
        }
        var results = _.map(sortedKeys, function (key) { return _this._data[key]; });
        return SyncTasks.Resolved(_.flatten(results));
    };
    return InMemoryIndex;
}());
