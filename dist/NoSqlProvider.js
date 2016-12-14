/**
 * NoSqlProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2016
 *
 * Low-level wrapper to expose a nosql-like database which can be backed by
 * numerous different backend store types, invisible to the consumer.  The
 * usage semantics are very similar to IndexedDB.  This file contains most
 * of the helper interfaces, while the specific database providers should
 * be required piecemeal.
 */
"use strict";
var SyncTasks = require('synctasks');
// Abstract base type for a database provider.  Has accessors for opening transactions and one-off accesor helpers.
// Note: this is a different concept than a DbStore or DbIndex, although it provides a similar (or identical) interface.
var DbProvider = (function () {
    function DbProvider() {
    }
    DbProvider.prototype.open = function (dbName, schema, wipeIfExists, verbose) {
        // virtual call
        this._schema = schema;
        this._verbose = verbose;
        return null;
    };
    DbProvider.prototype.clearAllData = function () {
        var storeNames = this._schema.stores.map(function (store) { return store.name; });
        return this.openTransaction(storeNames, true).then(function (trans) {
            var clearers = storeNames.map(function (storeName) {
                var store = trans.getStore(storeName);
                if (!store) {
                    return SyncTasks.Rejected('Store "' + storeName + '" not found');
                }
                return store.clearAllData();
            });
            return SyncTasks.all(clearers).then(function (rets) { return void 0; });
        });
    };
    DbProvider.prototype._getStoreTransaction = function (storeName, readWrite) {
        return this.openTransaction(storeName, readWrite).then(function (trans) {
            var store = trans.getStore(storeName);
            if (!store) {
                return SyncTasks.Rejected('Store "' + storeName + '" not found');
            }
            return store;
        });
    };
    // Shortcut functions
    DbProvider.prototype.get = function (storeName, key) {
        return this._getStoreTransaction(storeName, false).then(function (store) {
            return store.get(key);
        });
    };
    DbProvider.prototype.getMultiple = function (storeName, keyOrKeys) {
        return this._getStoreTransaction(storeName, false).then(function (store) {
            return store.getMultiple(keyOrKeys);
        });
    };
    DbProvider.prototype.put = function (storeName, itemOrItems) {
        return this._getStoreTransaction(storeName, true).then(function (store) {
            return store.put(itemOrItems);
        });
    };
    DbProvider.prototype.remove = function (storeName, keyOrKeys) {
        return this._getStoreTransaction(storeName, true).then(function (store) {
            return store.remove(keyOrKeys);
        });
    };
    DbProvider.prototype._getStoreIndexTransaction = function (storeName, readWrite, indexName) {
        return this._getStoreTransaction(storeName, readWrite).then(function (store) {
            var index = indexName ? store.openIndex(indexName) : store.openPrimaryKey();
            if (!index) {
                return SyncTasks.Rejected('Index "' + indexName + '" not found');
            }
            return index;
        });
    };
    DbProvider.prototype.getAll = function (storeName, indexName, reverse, limit, offset) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(function (index) {
            return index.getAll(reverse, limit, offset);
        });
    };
    DbProvider.prototype.getOnly = function (storeName, indexName, key, reverse, limit, offset) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(function (index) {
            return index.getOnly(key, reverse, limit, offset);
        });
    };
    DbProvider.prototype.getRange = function (storeName, indexName, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverse, limit, offset) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(function (index) {
            return index.getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverse, limit, offset);
        });
    };
    DbProvider.prototype.countAll = function (storeName, indexName) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(function (index) {
            return index.countAll();
        });
    };
    DbProvider.prototype.countOnly = function (storeName, indexName, key) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(function (index) {
            return index.countOnly(key);
        });
    };
    DbProvider.prototype.countRange = function (storeName, indexName, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(function (index) {
            return index.countRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
    };
    return DbProvider;
}());
exports.DbProvider = DbProvider;
// Runs down the given providers in order and tries to instantiate them.  If they're not supported, it will continue until it finds one
// that does work, or it will reject the promise if it runs out of providers and none work.
function openListOfProviders(providersToTry, dbName, schema, wipeIfExists, verbose) {
    if (wipeIfExists === void 0) { wipeIfExists = false; }
    if (verbose === void 0) { verbose = false; }
    var task = SyncTasks.Defer();
    var providerIndex = 0;
    var errorList = [];
    var tryNext = function () {
        if (providerIndex >= providersToTry.length) {
            task.reject(errorList.length <= 1 ? errorList[0] : errorList);
            return;
        }
        var provider = providersToTry[providerIndex];
        provider.open(dbName, schema, wipeIfExists, verbose).then(function () {
            task.resolve(provider);
        }, function (err) {
            errorList.push(err);
            providerIndex++;
            tryNext();
        });
    };
    tryNext();
    return task.promise();
}
exports.openListOfProviders = openListOfProviders;
