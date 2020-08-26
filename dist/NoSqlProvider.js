"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const lodash_1 = require("lodash");
require("./Promise");
var QuerySortOrder;
(function (QuerySortOrder) {
    QuerySortOrder[QuerySortOrder["None"] = 0] = "None";
    QuerySortOrder[QuerySortOrder["Forward"] = 1] = "Forward";
    QuerySortOrder[QuerySortOrder["Reverse"] = 2] = "Reverse";
})(QuerySortOrder = exports.QuerySortOrder || (exports.QuerySortOrder = {}));
var FullTextTermResolution;
(function (FullTextTermResolution) {
    FullTextTermResolution[FullTextTermResolution["And"] = 0] = "And";
    FullTextTermResolution[FullTextTermResolution["Or"] = 1] = "Or";
})(FullTextTermResolution = exports.FullTextTermResolution || (exports.FullTextTermResolution = {}));
// Abstract base type for a database provider.  Has accessors for opening transactions and one-off accesor helpers.
// Note: this is a different concept than a DbStore or DbIndex, although it provides a similar (or identical) interface.
class DbProvider {
    open(dbName, schema, wipeIfExists, verbose) {
        // virtual call
        this._dbName = dbName;
        this._schema = schema;
        this._verbose = verbose;
        return undefined;
    }
    deleteDatabase() {
        return this.close().always(() => this._deleteDatabaseInternal());
    }
    clearAllData() {
        var storeNames = this._schema.stores.map(store => store.name);
        return this.openTransaction(storeNames, true).then(trans => {
            const clearers = storeNames.map(storeName => {
                const store = lodash_1.attempt(() => {
                    return trans.getStore(storeName);
                });
                if (!store || lodash_1.isError(store)) {
                    return Promise.reject('Store "' + storeName + '" not found');
                }
                return store.clearAllData();
            });
            return Promise.all(clearers).then(lodash_1.noop);
        });
    }
    _getStoreTransaction(storeName, readWrite) {
        return this.openTransaction([storeName], readWrite).then(trans => {
            const store = lodash_1.attempt(() => {
                return trans.getStore(storeName);
            });
            if (!store || lodash_1.isError(store)) {
                return Promise.reject('Store "' + storeName + '" not found');
            }
            return Promise.resolve(store);
        });
    }
    // Shortcut functions
    get(storeName, key) {
        return this._getStoreTransaction(storeName, false).then(store => {
            return store.get(key);
        });
    }
    getMultiple(storeName, keyOrKeys) {
        return this._getStoreTransaction(storeName, false).then(store => {
            return store.getMultiple(keyOrKeys);
        });
    }
    put(storeName, itemOrItems) {
        return this._getStoreTransaction(storeName, true).then(store => {
            return store.put(itemOrItems);
        });
    }
    remove(storeName, keyOrKeys) {
        return this._getStoreTransaction(storeName, true).then(store => {
            return store.remove(keyOrKeys);
        });
    }
    _getStoreIndexTransaction(storeName, readWrite, indexName) {
        return this._getStoreTransaction(storeName, readWrite).then(store => {
            const index = lodash_1.attempt(() => {
                return indexName ? store.openIndex(indexName) : store.openPrimaryKey();
            });
            if (!index || lodash_1.isError(index)) {
                return Promise.reject('Index "' + indexName + '" not found');
            }
            return Promise.resolve(index);
        });
    }
    getAll(storeName, indexName, reverseOrSortOrder, limit, offset) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.getAll(reverseOrSortOrder, limit, offset);
        });
    }
    getOnly(storeName, indexName, key, reverseOrSortOrder, limit, offset) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.getOnly(key, reverseOrSortOrder, limit, offset);
        });
    }
    getRange(storeName, indexName, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset);
        });
    }
    countAll(storeName, indexName) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.countAll();
        });
    }
    countOnly(storeName, indexName, key) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.countOnly(key);
        });
    }
    countRange(storeName, indexName, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.countRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
    }
    fullTextSearch(storeName, indexName, searchPhrase, resolution = FullTextTermResolution.And, limit) {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.fullTextSearch(searchPhrase, resolution);
        });
    }
}
exports.DbProvider = DbProvider;
// Runs down the given providers in order and tries to instantiate them.  If they're not supported, it will continue until it finds one
// that does work, or it will reject the promise if it runs out of providers and none work.
function openListOfProviders(providersToTry, dbName, schema, wipeIfExists = false, verbose = false) {
    return new Promise((resolve, reject) => {
        let providerIndex = 0;
        let errorList = [];
        var tryNext = () => {
            if (providerIndex >= providersToTry.length) {
                reject(errorList.length <= 1 ? errorList[0] : errorList);
                return;
            }
            var provider = providersToTry[providerIndex];
            provider.open(dbName, schema, wipeIfExists, verbose).then(() => {
                resolve(provider);
            }, (err) => {
                errorList.push(err);
                providerIndex++;
                tryNext();
            });
        };
        tryNext();
    });
}
exports.openListOfProviders = openListOfProviders;
//# sourceMappingURL=NoSqlProvider.js.map