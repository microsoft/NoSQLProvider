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

import SyncTasks = require('synctasks');

// Schema type describing an index for a store.
export interface IndexSchema {
    name: string;
    keyPath: string | string[];
    unique?: boolean;
    multiEntry?: boolean;
    fullText?: boolean;
}

// Schema type describing a data store.  Must give a keypath for the primary key for the store.  Further indexes are optional.
export interface StoreSchema {
    name: string;
    indexes?: IndexSchema[];
    primaryKeyPath: string | string[];
}

// Schema representing a whole database (a collection of stores).  Change your version number whenever you change your schema or
// the new schema will have no effect, as it only checks schema differences during a version change process.
export interface DbSchema {
    version: number;
    // If set, during the upgrade path, all versions below this will be cleared and built from scratch rather than upgraded
    lastUsableVersion?: number;
    stores: StoreSchema[];
}

// Interface type describing an index being opened for querying.
export interface DbIndex {
    getAll<T>(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    getOnly<T>(key: any|any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    getRange<T>(keyLowRange: any|any[], keyHighRange: any|any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    countAll(): SyncTasks.Promise<number>;
    countOnly(key: any|any[]): SyncTasks.Promise<number>;
    countRange(keyLowRange: any|any[], keyHighRange: any|any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : SyncTasks.Promise<number>;
    fullTextSearch<T>(searchPhrase: string): SyncTasks.Promise<T[]>;
}

// Interface type describing a database store opened for accessing.  Get commands at this level work against the primary keypath
// of the store.
export interface DbStore {
    get<T>(key: any|any[]): SyncTasks.Promise<T>;
    getMultiple<T>(keyOrKeys: any|any[]): SyncTasks.Promise<T[]>;
    put(itemOrItems: any|any[]): SyncTasks.Promise<void>;
    remove(keyOrKeys: any|any[]): SyncTasks.Promise<void>;

    openPrimaryKey(): DbIndex;
    openIndex(indexName: string): DbIndex;

    clearAllData(): SyncTasks.Promise<void>;
}

// Interface type describing a transaction.  All accesses to a database must go through a transaction, though the provider has
// shortcut accessor functions that get a transaction for you for the one-off queries.
export interface DbTransaction {
    getStore(storeName: string): DbStore;
}

// Abstract base type for a database provider.  Has accessors for opening transactions and one-off accesor helpers.
// Note: this is a different concept than a DbStore or DbIndex, although it provides a similar (or identical) interface.
export abstract class DbProvider {
    protected _schema: DbSchema;
    protected _verbose: boolean;

    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        // virtual call
        this._schema = schema;
        this._verbose = verbose;
        return null;
    }

    abstract close(): SyncTasks.Promise<void>;

    // You must perform all of your actions on the transaction handed to you in the callback block without letting it expire.
    // When the last callback from the last executed action against the DbTransaction is executed, the transaction closes, so be very
    // careful using deferrals/promises that may wait for the main thread to close out before handling your response.
    abstract openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<DbTransaction>;

    clearAllData(): SyncTasks.Promise<void> {
        var storeNames = this._schema.stores.map(store => store.name);

        return this.openTransaction(storeNames, true).then(trans => {
            const clearers = storeNames.map(storeName => {
                const store = trans.getStore(storeName);
                if (!store) {
                    return SyncTasks.Rejected<void>('Store "' + storeName + '" not found');
                }
                return store.clearAllData();
            });
            return SyncTasks.all(clearers).then(rets => void 0);
        });
    }

    private _getStoreTransaction(storeName: string, readWrite: boolean): SyncTasks.Promise<DbStore> {
        return this.openTransaction(storeName, readWrite).then(trans => {
            const store = trans.getStore(storeName);
            if (!store) {
                return SyncTasks.Rejected('Store "' + storeName + '" not found');
            }
            return store;
        });
    }

    // Shortcut functions
    get<T>(storeName: string, key: any|any[]): SyncTasks.Promise<T> {
        return this._getStoreTransaction(storeName, false).then(store => {
            return store.get<T>(key);
        });
    }

    getMultiple<T>(storeName: string, keyOrKeys: any|any[]): SyncTasks.Promise<T[]> {
        return this._getStoreTransaction(storeName, false).then(store => {
            return store.getMultiple<T>(keyOrKeys);
        });
    }

    put(storeName: string, itemOrItems: any|any[]): SyncTasks.Promise<void> {
        return this._getStoreTransaction(storeName, true).then(store => {
            return store.put(itemOrItems);
        });
    }

    remove(storeName: string, keyOrKeys: any|any[]): SyncTasks.Promise<void> {
        return this._getStoreTransaction(storeName, true).then(store => {
            return store.remove(keyOrKeys);
        });
    }

    private _getStoreIndexTransaction(storeName: string, readWrite: boolean, indexName: string): SyncTasks.Promise<DbIndex> {
        return this._getStoreTransaction(storeName, readWrite).then(store => {
            const index = indexName ? store.openIndex(indexName) : store.openPrimaryKey();
            if (!index) {
                return SyncTasks.Rejected('Index "' + indexName + '" not found');
            }
            return index;
        });
    }

    getAll<T>(storeName: string, indexName?: string, reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.getAll<T>(reverse, limit, offset);
        });
    }

    getOnly<T>(storeName: string, indexName: string, key: any|any[], reverse?: boolean, limit?: number, offset?: number)
            : SyncTasks.Promise<T[]> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.getOnly<T>(key, reverse, limit, offset);
        });
    }

    getRange<T>(storeName: string, indexName: string, keyLowRange: any|any[], keyHighRange: any|any[],
        lowRangeExclusive?: boolean, highRangeExclusive?: boolean, reverse?: boolean, limit?: number, offset?: number)
            : SyncTasks.Promise<T[]> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.getRange<T>(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverse, limit, offset);
        });
    }

    countAll(storeName: string, indexName?: string): SyncTasks.Promise<number> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.countAll();
        });
    }

    countOnly(storeName: string, indexName: string, key: any|any[]): SyncTasks.Promise<number> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.countOnly(key);
        });
    }

    countRange(storeName: string, indexName: string, keyLowRange: any|any[], keyHighRange: any|any[],
            lowRangeExclusive?: boolean, highRangeExclusive?: boolean): SyncTasks.Promise<number> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.countRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
    }

    fullTextSearch<T>(storeName: string, indexName: string, searchPhrase: string): SyncTasks.Promise<T[]> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.fullTextSearch(searchPhrase);
        });
    }
}

// Runs down the given providers in order and tries to instantiate them.  If they're not supported, it will continue until it finds one
// that does work, or it will reject the promise if it runs out of providers and none work.
export function openListOfProviders(providersToTry: DbProvider[], dbName: string, schema: DbSchema, wipeIfExists: boolean = false,
        verbose: boolean = false): SyncTasks.Promise<DbProvider> {
    const task = SyncTasks.Defer<DbProvider>();
    let providerIndex = 0;
    let errorList: any[] = [];

    var tryNext = () => {
        if (providerIndex >= providersToTry.length) {
            task.reject(errorList.length <= 1 ? errorList[0] : errorList);
            return;
        }

        var provider = providersToTry[providerIndex];
        provider.open(dbName, schema, wipeIfExists, verbose).then(() => {
            task.resolve(provider);
        }, (err) => {
            errorList.push(err);
            providerIndex++;
            tryNext();
        });
    };

    tryNext();

    return task.promise();
}
