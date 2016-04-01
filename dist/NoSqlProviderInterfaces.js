/**
 * NoSqlProviderInterfaces.ts
 * Author: David de Regt
 * Copyright: Microsoft 2016
 *
 * Basic interfaces and openListOfProviders function to export for module usage.
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
            var clearers = storeNames.map(function (name) {
                var store = trans.getStore(name);
                return store.clearAllData();
            });
            return SyncTasks.whenAll(clearers).then(function (rets) { return void 0; });
        });
    };
    // Shortcut functions
    DbProvider.prototype.get = function (storeName, key) {
        return this.openTransaction(storeName, false).then(function (trans) {
            var store = trans.getStore(storeName);
            return store.get(key);
        });
    };
    DbProvider.prototype.getMultiple = function (storeName, keyOrKeys) {
        return this.openTransaction(storeName, false).then(function (trans) {
            var store = trans.getStore(storeName);
            return store.getMultiple(keyOrKeys);
        });
    };
    DbProvider.prototype.put = function (storeName, itemOrItems) {
        return this.openTransaction(storeName, true).then(function (trans) {
            var store = trans.getStore(storeName);
            return store.put(itemOrItems);
        });
    };
    DbProvider.prototype.remove = function (storeName, keyOrKeys) {
        return this.openTransaction(storeName, true).then(function (trans) {
            var store = trans.getStore(storeName);
            return store.remove(keyOrKeys);
        });
    };
    DbProvider.prototype.getAll = function (storeName, indexName, reverse, limit, offset) {
        return this.openTransaction(storeName, false).then(function (trans) {
            var store = trans.getStore(storeName);
            var index = indexName ? store.openIndex(indexName) : store.openPrimaryKey();
            return index.getAll(reverse, limit, offset);
        });
    };
    DbProvider.prototype.getOnly = function (storeName, indexName, key, reverse, limit, offset) {
        return this.openTransaction(storeName, false).then(function (trans) {
            var store = trans.getStore(storeName);
            var index = indexName ? store.openIndex(indexName) : store.openPrimaryKey();
            return index.getOnly(key, reverse, limit, offset);
        });
    };
    DbProvider.prototype.getRange = function (storeName, indexName, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverse, limit, offset) {
        return this.openTransaction(storeName, false).then(function (trans) {
            var store = trans.getStore(storeName);
            var index = indexName ? store.openIndex(indexName) : store.openPrimaryKey();
            return index.getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverse, limit, offset);
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
    var tryNext = function () {
        if (providerIndex >= providersToTry.length) {
            task.reject();
            return;
        }
        var provider = providersToTry[providerIndex];
        provider.open(dbName, schema, wipeIfExists, verbose).then(function () {
            task.resolve(provider);
        }, function () {
            providerIndex++;
            tryNext();
        });
    };
    tryNext();
    return task.promise();
}
exports.openListOfProviders = openListOfProviders;
