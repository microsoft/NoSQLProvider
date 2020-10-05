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
import "./Promise.extensions"; // See the file for why it is being imported like this.
import { noop, attempt, isError } from 'lodash';
import * as SyncTasks from 'synctasks';

// Basic nomenclature types for everyone to agree on.
export type ItemType = object;
export type KeyComponentType = string|number|Date;
export type KeyType = KeyComponentType|KeyComponentType[];
export type KeyPathType = string | string[];
export enum QuerySortOrder {
    None,
    Forward,
    Reverse
}

// Schema type describing an index for a store.
export interface IndexSchema {
    name: string;
    keyPath: KeyPathType;
    unique?: boolean;
    multiEntry?: boolean;
    fullText?: boolean;
    includeDataInIndex?: boolean;
    doNotBackfill?: boolean;
}

// Schema type describing a data store.  Must give a keypath for the primary key for the store.  Further indexes are optional.
export interface StoreSchema {
    name: string;
    indexes?: IndexSchema[];
    primaryKeyPath: KeyPathType;
    // Estimated object size to enable batched data migration. Default = 200
    estimatedObjBytes?: number;
}

// Schema representing a whole database (a collection of stores).  Change your version number whenever you change your schema or
// the new schema will have no effect, as it only checks schema differences during a version change process.
export interface DbSchema {
    version: number;
    // If set, during the upgrade path, all versions below this will be cleared and built from scratch rather than upgraded
    lastUsableVersion?: number;
    stores: StoreSchema[];
}

export enum FullTextTermResolution {
    And,
    Or
}

// Interface type describing an index being opened for querying.
export interface DbIndex {
    getAll(reverseOrSortOrder?: boolean|QuerySortOrder, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]>;
    getOnly(key: KeyType, reverseOrSortOrder?: boolean|QuerySortOrder, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]>;
    getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverseOrSortOrder?: boolean|QuerySortOrder, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]>;
    countAll(): SyncTasks.Promise<number>;
    countOnly(key: KeyType): SyncTasks.Promise<number>;
    countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : SyncTasks.Promise<number>;
    fullTextSearch(searchPhrase: string, resolution?: FullTextTermResolution, limit?: number): SyncTasks.Promise<ItemType[]>;
}

// Interface type describing a database store opened for accessing.  Get commands at this level work against the primary keypath
// of the store.
export interface DbStore {
    get(key: KeyType): SyncTasks.Promise<ItemType|undefined>;
    getMultiple(keyOrKeys: KeyType|KeyType[]): SyncTasks.Promise<ItemType[]>;
    put(itemOrItems: ItemType|ItemType[]): SyncTasks.Promise<void>;
    remove(keyOrKeys: KeyType|KeyType[]): SyncTasks.Promise<void>;

    openPrimaryKey(): DbIndex;
    openIndex(indexName: string): DbIndex;

    clearAllData(): SyncTasks.Promise<void>;
}

// Interface type describing a transaction.  All accesses to a database must go through a transaction, though the provider has
// shortcut accessor functions that get a transaction for you for the one-off queries.
export interface DbTransaction {
    getStore(storeName: string): DbStore;
    // This promise will resolve when the transaction commits, or will reject when there's a transaction-level error.
    getCompletionPromise(): SyncTasks.Promise<void>;
    // Attempt to abort the transaction (if it hasn't yet completed or aborted).  Completion will be detectable via the
    // getCompletionPromise promise.
    abort(): void;
    // This method is noop for most of implementations
    // react-native implementation could use this as an opportunity to finish transactions without additional bridge delay
    markCompleted(): void;
}

// Abstract base type for a database provider.  Has accessors for opening transactions and one-off accesor helpers.
// Note: this is a different concept than a DbStore or DbIndex, although it provides a similar (or identical) interface.
export abstract class DbProvider {
    protected _dbName: string|undefined;
    protected _schema: DbSchema|undefined;
    protected _verbose: boolean|undefined;

    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        // virtual call
        this._dbName = dbName;
        this._schema = schema;
        this._verbose = verbose;
        return undefined!!!;
    }

    abstract close(): SyncTasks.Promise<void>;

    // You must perform all of your actions on the transaction handed to you in the callback block without letting it expire.
    // When the last callback from the last executed action against the DbTransaction is executed, the transaction closes, so be very
    // careful using deferrals/promises that may wait for the main thread to close out before handling your response.
    // Undefined for storeNames means ALL stores.
    abstract openTransaction(storeNames: string[]|undefined, writeNeeded: boolean): SyncTasks.Promise<DbTransaction>;

    deleteDatabase(): SyncTasks.Promise<void> {
        return this.close().always(() => this._deleteDatabaseInternal());
    }

    clearAllData(): SyncTasks.Promise<void> {
        var storeNames = this._schema!!!.stores.map(store => store.name);

        return this.openTransaction(storeNames, true).then(trans => {
            const clearers = storeNames.map(storeName => {
                const store = attempt(() => {
                    return trans.getStore(storeName);
                });
                if (!store || isError(store)) {
                    return SyncTasks.Rejected<void>('Store "' + storeName + '" not found');
                }
                return store.clearAllData();
            });
            return SyncTasks.all(clearers).then(noop);
        });
    }

    protected abstract _deleteDatabaseInternal(): SyncTasks.Promise<void>;

    private _getStoreTransaction(storeName: string, readWrite: boolean): SyncTasks.Promise<DbStore> {
        return this.openTransaction([storeName], readWrite).then(trans => {
            const store = attempt(() => {
                return trans.getStore(storeName);
            });
            if (!store || isError(store)) {
                return SyncTasks.Rejected('Store "' + storeName + '" not found');
            }
            return store;
        });
    }

    // Shortcut functions
    get(storeName: string, key: KeyType): SyncTasks.Promise<ItemType|undefined> {
        return this._getStoreTransaction(storeName, false).then(store => {
            return store.get(key);
        });
    }

    getMultiple(storeName: string, keyOrKeys: KeyType|KeyType[]): SyncTasks.Promise<ItemType[]> {
        return this._getStoreTransaction(storeName, false).then(store => {
            return store.getMultiple(keyOrKeys);
        });
    }

    put(storeName: string, itemOrItems: ItemType|ItemType[]): SyncTasks.Promise<void> {
        return this._getStoreTransaction(storeName, true).then(store => {
            return store.put(itemOrItems);
        });
    }

    remove(storeName: string, keyOrKeys: KeyType|KeyType[]): SyncTasks.Promise<void> {
        return this._getStoreTransaction(storeName, true).then(store => {
            return store.remove(keyOrKeys);
        });
    }

    private _getStoreIndexTransaction(storeName: string, readWrite: boolean, indexName: string|undefined): SyncTasks.Promise<DbIndex> {
        return this._getStoreTransaction(storeName, readWrite).then(store => {
            const index = attempt(() => {
                return indexName ? store.openIndex(indexName) : store.openPrimaryKey();
            });
            if (!index || isError(index)) {
                return SyncTasks.Rejected('Index "' + indexName + '" not found');
            }
            return index;
        });
    }

    getAll(storeName: string, indexName: string|undefined, reverseOrSortOrder?: boolean|QuerySortOrder, limit?: number, offset?: number)
            : SyncTasks.Promise<ItemType[]> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.getAll(reverseOrSortOrder, limit, offset);
        });
    }

    getOnly(storeName: string, indexName: string | undefined, key: KeyType, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number,
            offset?: number): SyncTasks.Promise<ItemType[]> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.getOnly(key, reverseOrSortOrder, limit, offset);
        });
    }

    getRange(storeName: string, indexName: string | undefined, keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean,
            highRangeExclusive?: boolean, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number)
            : SyncTasks.Promise<ItemType[]> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset);
        });
    }

    countAll(storeName: string, indexName: string|undefined): SyncTasks.Promise<number> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.countAll();
        });
    }

    countOnly(storeName: string, indexName: string|undefined, key: KeyType): SyncTasks.Promise<number> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.countOnly(key);
        });
    }

    countRange(storeName: string, indexName: string|undefined, keyLowRange: KeyType, keyHighRange: KeyType,
            lowRangeExclusive?: boolean, highRangeExclusive?: boolean): SyncTasks.Promise<number> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.countRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
    }

    fullTextSearch(storeName: string, indexName: string, searchPhrase: string,
            resolution: FullTextTermResolution = FullTextTermResolution.And, limit?: number): SyncTasks.Promise<ItemType[]> {
        return this._getStoreIndexTransaction(storeName, false, indexName).then(index => {
            return index.fullTextSearch(searchPhrase, resolution);
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
