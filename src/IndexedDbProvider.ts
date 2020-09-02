/**
 * IndexedDbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for IndexedDB, a web browser storage module.
 */

import { each, some, find, includes, isObject, attempt, isError, map, filter, compact, clone, isArray, noop, flatten } from 'lodash';

import { DbIndexFTSFromRangeQueries, getFullTextIndexWordsForItem } from './FullTextSearchHelpers';
import { DbProvider, DbSchema, DbStore, DbTransaction, StoreSchema, DbIndex, QuerySortOrder, IndexSchema } from './NoSqlProvider';
import { ItemType, KeyPathType, KeyType } from './NoSqlProvider';
import {
    isIE, isCompoundKeyPath, serializeKeyToString, getKeyForKeypath, arrayify, formListOfKeys,
    getValueForSingleKeypath, getSerializedKeyForKeypath
} from './NoSqlProviderUtils';
import { TransactionToken, TransactionLockHelper } from './TransactionLockHelper';

const IndexPrefix = 'nsp_i_';

// Extending interfaces that should be in lib.d.ts but aren't for some reason.
declare global {
    interface Window {
        _indexedDB: IDBFactory;
        mozIndexedDB: IDBFactory;
        webkitIndexedDB: IDBFactory;
        msIndexedDB: IDBFactory;
    }
}

// The DbProvider implementation for IndexedDB.  This one is fairly straightforward since the library's access patterns pretty
// closely mirror IndexedDB's.  We mostly do a lot of wrapping of the APIs into JQuery promises and have some fancy footwork to
// do semi-automatic schema upgrades.
export class IndexedDbProvider extends DbProvider {
    private _db: IDBDatabase | undefined;
    private _dbFactory: IDBFactory;
    private _fakeComplicatedKeys: boolean;

    private _lockHelper: TransactionLockHelper | undefined;

    // By default, it uses the in-browser indexed db factory, but you can pass in an explicit factory.  Currently only used for unit tests.
    constructor(explicitDbFactory?: IDBFactory, explicitDbFactorySupportsCompoundKeys?: boolean) {
        super();

        if (explicitDbFactory) {
            this._dbFactory = explicitDbFactory;
            this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
        } else {
            const win = this.getWindow();
            this._dbFactory = win._indexedDB || win.indexedDB || win.mozIndexedDB || win.webkitIndexedDB || win.msIndexedDB;

            if (typeof explicitDbFactorySupportsCompoundKeys !== 'undefined') {
                this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
            } else {
                // IE/Edge's IndexedDB implementation doesn't support compound keys, so we have to fake it by implementing them similar to
                // how the WebSqlProvider does, by concatenating the values into another field which then gets its own index.
                this._fakeComplicatedKeys = isIE();
            }
        }
    }

    /**
     * Gets global window object - whether operating in worker or UI thread context.
     * Adapted from: https://stackoverflow.com/questions/7931182/reliably-detect-if-the-script-is-executing-in-a-web-worker
     */
    getWindow() {
        if (typeof window === 'object' && window.document) {
            return window;
        } else if (self && self.document === undefined) {
            return self;
        }

        throw new Error('Undefined context');
    }

    static WrapRequest<T>(req: IDBRequest): Promise<T> {
        return new Promise((resolve, reject) => {
            req.onsuccess = (/*ev*/) => {
                resolve(req.result);
            };
            req.onerror = (ev) => {
                reject(ev);
            };
        });
    }

    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, verbose: boolean): Promise<void> {
        // Note: DbProvider returns null instead of a promise that needs waiting for.
        super.open(dbName, schema, wipeIfExists, verbose);

        if (!this._dbFactory) {
            // Couldn't even find a supported indexeddb object on the browser...
            return Promise.reject<void>('No support for IndexedDB in this browser');
        }

        if (wipeIfExists) {
            try {
                this._dbFactory.deleteDatabase(dbName);
            } catch (e) {
                // Don't care
            }
        }

        this._lockHelper = new TransactionLockHelper(schema, true);

        const dbOpen = this._dbFactory.open(dbName, schema.version);

        let migrationPutters: Promise<void>[] = [];

        dbOpen.onupgradeneeded = (event) => {
            const db: IDBDatabase = dbOpen.result;
            const target = <IDBOpenDBRequest>(event.currentTarget || event.target);
            const trans = target.transaction;

            if (!trans) {
                throw new Error('onupgradeneeded: target is null!');
            }

            if (schema.lastUsableVersion && event.oldVersion < schema.lastUsableVersion) {
                // Clear all stores if it's past the usable version
                console.log('Old version detected (' + event.oldVersion + '), clearing all data');
                each(db.objectStoreNames, name => {
                    db.deleteObjectStore(name);
                });
            }

            // Delete dead stores
            each(db.objectStoreNames, storeName => {
                if (!some(schema.stores, store => store.name === storeName)) {
                    db.deleteObjectStore(storeName);
                }
            });

            // Create all stores
            each(schema.stores, storeSchema => {
                let store: IDBObjectStore;
                const storeExistedBefore = includes(db.objectStoreNames, storeSchema.name);
                if (!storeExistedBefore) { // store doesn't exist yet
                    let primaryKeyPath = storeSchema.primaryKeyPath;
                    if (this._fakeComplicatedKeys && isCompoundKeyPath(primaryKeyPath)) {
                        // Going to have to hack the compound primary key index into a column, so here it is.
                        primaryKeyPath = 'nsp_pk';
                    }

                    // Any is to fix a lib.d.ts issue in TS 2.0.3 - it doesn't realize that keypaths can be compound for some reason...
                    store = db.createObjectStore(storeSchema.name, { keyPath: primaryKeyPath } as any);
                } else { // store exists, might need to update indexes and migrate the data
                    store = trans.objectStore(storeSchema.name);

                    // Check for any indexes no longer in the schema or have been changed
                    each(store.indexNames, indexName => {
                        const index = store.index(indexName);

                        let nuke = false;
                        const indexSchema = find(storeSchema.indexes, idx => idx.name === indexName);
                        if (!indexSchema || !isObject(indexSchema)) {
                            nuke = true;
                        } else if (typeof index.keyPath !== typeof indexSchema.keyPath) {
                            nuke = true;
                        } else if (typeof index.keyPath === 'string') {
                            if (index.keyPath !== indexSchema.keyPath) {
                                nuke = true;
                            }
                        } else /* Keypath is array */ if (index.keyPath.length !== indexSchema.keyPath.length) {
                            // Keypath length doesn't match, don't bother doing a comparison of each element
                            nuke = true;
                        } else {
                            for (let i = 0; i < index.keyPath.length; i++) {
                                if (index.keyPath[i] !== indexSchema.keyPath[i]) {
                                    nuke = true;
                                    break;
                                }
                            }
                        }

                        if (nuke) {
                            store.deleteIndex(indexName);
                        }
                    });
                }

                // IndexedDB deals well with adding new indexes on the fly, so we don't need to force migrate, 
                // unless adding multiEntry or fullText index
                let needsMigrate = false;
                // Check any indexes in the schema that need to be created
                each(storeSchema.indexes, indexSchema => {
                    if (!includes(store.indexNames, indexSchema.name)) {
                        const keyPath = indexSchema.keyPath;
                        if (this._fakeComplicatedKeys) {
                            if (indexSchema.multiEntry || indexSchema.fullText) {
                                if (isCompoundKeyPath(keyPath)) {
                                    throw new Error('Can\'t use multiEntry and compound keys');
                                } else {
                                    // Create an object store for the index
                                    let indexStore = db.createObjectStore(storeSchema.name + '_' + indexSchema.name,
                                        { autoIncrement: true });
                                    indexStore.createIndex('key', 'key');
                                    indexStore.createIndex('refkey', 'refkey');

                                    if (storeExistedBefore && !indexSchema.doNotBackfill) {
                                        needsMigrate = true;
                                    }
                                }
                            } else if (isCompoundKeyPath(keyPath)) {
                                // Going to have to hack the compound index into a column, so here it is.
                                store.createIndex(indexSchema.name, IndexPrefix + indexSchema.name, {
                                    unique: indexSchema.unique
                                });
                            } else {
                                store.createIndex(indexSchema.name, keyPath, {
                                    unique: indexSchema.unique
                                });
                            }
                        } else if (indexSchema.fullText) {
                            store.createIndex(indexSchema.name, IndexPrefix + indexSchema.name, {
                                unique: false,
                                multiEntry: true
                            });

                            if (storeExistedBefore && !indexSchema.doNotBackfill) {
                                needsMigrate = true;
                            }
                        } else {
                            store.createIndex(indexSchema.name, keyPath, {
                                unique: indexSchema.unique,
                                multiEntry: indexSchema.multiEntry
                            });
                        }
                    }
                });

                if (needsMigrate) {
                    // Walk every element in the store and re-put it to fill out the new index.
                    const fakeToken: TransactionToken = {
                        storeNames: [storeSchema.name],
                        exclusive: false,
                        completionPromise: new Promise((resolve) => resolve())
                    };
                    const iTrans = new IndexedDbTransaction(trans, undefined, fakeToken, schema, this._fakeComplicatedKeys);
                    const tStore = iTrans.getStore(storeSchema.name);

                    const cursorReq = store.openCursor();
                    let thisIndexPutters: Promise<void>[] = [];
                    migrationPutters.push(IndexedDbIndex.iterateOverCursorRequest(cursorReq, cursor => {
                        const err = attempt(() => {
                            const item = removeFullTextMetadataAndReturn(storeSchema, (cursor as any).value);

                            thisIndexPutters.push(tStore.put(item));
                        });
                        if (err) {
                            thisIndexPutters.push(Promise.reject<void>(err));
                        }
                    }).then(() => Promise.all(thisIndexPutters).then(noop)));
                }
            });
        };

        const promise = IndexedDbProvider.WrapRequest<IDBDatabase>(dbOpen);

        return promise.then(db => {
            return Promise.all(migrationPutters).then(() => {
                this._db = db;
            });
        }, err => {
            if (err && err.type === 'error' && err.target && err.target.error && err.target.error.name === 'VersionError') {
                if (!wipeIfExists) {
                    console.log('Database version too new, Wiping: ' + (err.target.error.message || err.target.error.name));

                    return this.open(dbName, schema, true, verbose);
                }
            }
            return Promise.reject<void>(err);
        });
    }

    close(): Promise<void> {
        if (!this._db) {
            return Promise.reject('Database already closed');
        }

        this._db.close();
        this._db = undefined;
        return Promise.resolve<void>(void 0);
    }

    protected _deleteDatabaseInternal(): Promise<void> {
        const trans = attempt(() => {
            return this._dbFactory.deleteDatabase(this._dbName!!!);
        });

        if (isError(trans)) {
            return Promise.reject(trans);
        }

        return new Promise((resolve, reject) => {
            trans.onsuccess = () => {
                resolve(void 0);
            };
            trans.onerror = (ev) => {
                reject(ev);
            };
        });
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): Promise<DbTransaction> {
        if (!this._db) {
            return Promise.reject('Can\'t openTransaction, database is closed');
        }

        let intStoreNames = storeNames;

        if (this._fakeComplicatedKeys) {
            // Clone the list becuase we're going to add fake store names to it
            intStoreNames = clone(storeNames);

            // Pull the alternate multientry stores into the transaction as well
            let missingStores: string[] = [];
            each(storeNames, storeName => {
                let storeSchema = find(this._schema!!!.stores, s => s.name === storeName);
                if (!storeSchema) {
                    missingStores.push(storeName);
                    return;
                }
                if (storeSchema.indexes) {
                    each(storeSchema.indexes, indexSchema => {
                        if (indexSchema.multiEntry || indexSchema.fullText) {
                            intStoreNames.push(storeSchema!!!.name + '_' + indexSchema.name);
                        }
                    });
                }
            });
            if (missingStores.length > 0) {
                return Promise.reject('Can\'t find store(s): ' + missingStores.join(','));
            }
        }

        return this._lockHelper!!!.openTransaction(storeNames, writeNeeded).then(transToken => {
            const trans = attempt(() => {
                return this._db!!!.transaction(intStoreNames, writeNeeded ? 'readwrite' : 'readonly');
            });
            if (isError(trans)) {
                return Promise.reject(trans);
            }

            return Promise.resolve(
                new IndexedDbTransaction(trans, this._lockHelper, transToken, this._schema!!!, this._fakeComplicatedKeys));
        });
    }
}

// DbTransaction implementation for the IndexedDB DbProvider.
class IndexedDbTransaction implements DbTransaction {
    private _stores: IDBObjectStore[];

    constructor(private _trans: IDBTransaction, lockHelper: TransactionLockHelper | undefined, private _transToken: TransactionToken,
        private _schema: DbSchema, private _fakeComplicatedKeys: boolean) {
        this._stores = map(this._transToken.storeNames, storeName => this._trans.objectStore(storeName));

        if (lockHelper) {
            // Chromium seems to have a bug in their indexeddb implementation that lets it start a timeout
            // while the app is in the middle of a commit (it does a two-phase commit).  It can then finish
            // the commit, and later fire the timeout, despite the transaction having been written out already.
            // In this case, it appears that we should be completely fine to ignore the spurious timeout.
            //
            // Applicable Chromium source code here:
            // https://chromium.googlesource.com/chromium/src/+/master/content/browser/indexed_db/indexed_db_transaction.cc
            let history: string[] = [];

            this._trans.oncomplete = () => {
                history.push('complete');

                lockHelper.transactionComplete(this._transToken);
            };

            this._trans.onerror = () => {
                history.push('error-' + (this._trans.error ? this._trans.error.message : ''));

                if (history.length > 1) {
                    console.warn('IndexedDbTransaction Errored after Resolution, Swallowing. Error: ' +
                        (this._trans.error ? this._trans.error.message : undefined) + ', History: ' + history.join(','));
                    return;
                }

                lockHelper.transactionFailed(this._transToken, 'IndexedDbTransaction OnError: ' +
                    (this._trans.error ? this._trans.error.message : undefined) + ', History: ' + history.join(','));
            };

            this._trans.onabort = () => {
                history.push('abort-' + (this._trans.error ? this._trans.error.message : ''));

                if (history.length > 1) {
                    console.warn('IndexedDbTransaction Aborted after Resolution, Swallowing. Error: ' +
                        (this._trans.error ? this._trans.error.message : undefined) + ', History: ' + history.join(','));
                    return;
                }

                lockHelper.transactionFailed(this._transToken, 'IndexedDbTransaction Aborted, Error: ' +
                    (this._trans.error ? this._trans.error.message : undefined) + ', History: ' + history.join(','));
            };
        }
    }

    getStore(storeName: string): DbStore {
        const store = find(this._stores, s => s.name === storeName);
        const storeSchema = find(this._schema.stores, s => s.name === storeName);
        if (!store || !storeSchema) {
            throw new Error('Store not found: ' + storeName);
        }

        const indexStores: IDBObjectStore[] = [];
        if (this._fakeComplicatedKeys && storeSchema.indexes) {
            // Pull the alternate multientry stores in as well
            each(storeSchema.indexes, indexSchema => {
                if (indexSchema.multiEntry || indexSchema.fullText) {
                    indexStores.push(this._trans.objectStore(storeSchema.name + '_' + indexSchema.name));
                }
            });
        }

        return new IndexedDbStore(store, indexStores, storeSchema, this._fakeComplicatedKeys);
    }

    getCompletionPromise(): Promise<void> {
        return this._transToken.completionPromise;
    }

    abort(): void {
        // This will wrap through the onAbort above
        this._trans.abort();
    }

    markCompleted(): void {
        // noop
    }
}

function removeFullTextMetadataAndReturn<T>(schema: StoreSchema, val: T): T {
    if (val) {
        // We have full text index fields as real fields on the result, so nuke them before returning them to the caller.
        each(schema.indexes, index => {
            if (index.fullText) {
                delete (val as any)[IndexPrefix + index.name];
            }
        });
    }

    return val;
}

// DbStore implementation for the IndexedDB DbProvider.  Again, fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE.
class IndexedDbStore implements DbStore {
    constructor(private _store: IDBObjectStore, private _indexStores: IDBObjectStore[], private _schema: StoreSchema,
        private _fakeComplicatedKeys: boolean) {
        // NOP
    }

    get(key: KeyType): Promise<ItemType | undefined> {
        if (this._fakeComplicatedKeys && isCompoundKeyPath(this._schema.primaryKeyPath)) {
            const err = attempt(() => {
                key = serializeKeyToString(key, this._schema.primaryKeyPath);
            });
            if (err) {
                return Promise.reject(err);
            }
        }

        return IndexedDbProvider.WrapRequest(this._store.get(key))
            .then(val => removeFullTextMetadataAndReturn(this._schema, val));
    }

    getMultiple(keyOrKeys: KeyType | KeyType[]): Promise<ItemType[]> {
        const keys = attempt(() => {
            const keys = formListOfKeys(keyOrKeys, this._schema.primaryKeyPath);

            if (this._fakeComplicatedKeys && isCompoundKeyPath(this._schema.primaryKeyPath)) {
                return map(keys, key => serializeKeyToString(key, this._schema.primaryKeyPath));
            }
            return keys;
        });
        if (isError(keys)) {
            return Promise.reject(keys);
        }
        // There isn't a more optimized way to do this with indexeddb, have to get the results one by one
        return Promise.all(map(keys, key =>
            IndexedDbProvider.WrapRequest(this._store.get(key)).then(val => removeFullTextMetadataAndReturn(this._schema, val))))
            .then(compact);
    }

    put(itemOrItems: ItemType | ItemType[]): Promise<void> {
        let items = arrayify(itemOrItems);

        let promises: Promise<void>[] = [];

        const err = attempt(() => {
            each(items, item => {
                let errToReport: any;
                let fakedPk = false;

                if (this._fakeComplicatedKeys) {
                    // Fill out any compound-key indexes
                    if (isCompoundKeyPath(this._schema.primaryKeyPath)) {
                        fakedPk = true;
                        (item as any)['nsp_pk'] = getSerializedKeyForKeypath(item, this._schema.primaryKeyPath);
                    }

                    each(this._schema.indexes, index => {
                        if (index.multiEntry || index.fullText) {
                            let indexStore = find(this._indexStores, store => store.name === this._schema.name + '_' + index.name)!!!;

                            let keys: any[];
                            if (index.fullText) {
                                keys = getFullTextIndexWordsForItem(<string>index.keyPath, item);
                            } else {
                                // Get each value of the multientry and put it into the index store
                                const valsRaw = getValueForSingleKeypath(item, <string>index.keyPath);
                                // It might be an array of multiple entries, so just always go with array-based logic
                                keys = arrayify(valsRaw);
                            }

                            let refKey: any;
                            const err = attempt(() => {
                                // We're using normal indexeddb tables to store the multientry indexes, so we only need to use the key
                                // serialization if the multientry keys ALSO are compound.
                                if (isCompoundKeyPath(index.keyPath)) {
                                    keys = map(keys, val => serializeKeyToString(val, <string>index.keyPath));
                                }

                                // We need to reference the PK of the actual row we're using here, so calculate the actual PK -- if it's
                                // compound, we're already faking complicated keys, so we know to serialize it to a string.  If not, use the
                                // raw value.
                                refKey = getKeyForKeypath(item, this._schema.primaryKeyPath);
                                if (isArray(this._schema.primaryKeyPath)) {
                                    refKey = serializeKeyToString(refKey, this._schema.primaryKeyPath);
                                }
                            });

                            if (err) {
                                errToReport = err;
                                return false;
                            }

                            // First clear out the old values from the index store for the refkey
                            const cursorReq = indexStore.index('refkey').openCursor(IDBKeyRange.only(refKey));
                            promises.push(IndexedDbIndex.iterateOverCursorRequest(cursorReq, cursor => {
                                cursor['delete']();
                            })
                                .then(() => {
                                    // After nuking the existing entries, add the new ones
                                    let iputters = map(keys, key => {
                                        const indexObj = {
                                            key: key,
                                            refkey: refKey
                                        };
                                        return IndexedDbProvider.WrapRequest<void>(indexStore.put(indexObj));
                                    });
                                    return Promise.all(iputters);
                                }).then(noop));
                        } else if (isCompoundKeyPath(index.keyPath)) {
                            (item as any)[IndexPrefix + index.name] = getSerializedKeyForKeypath(item, index.keyPath);
                        }
                        return true;
                    });
                } else {
                    each(this._schema.indexes, index => {
                        if (index.fullText) {
                            (item as any)[IndexPrefix + index.name] =
                                getFullTextIndexWordsForItem(<string>index.keyPath, item);
                        }
                    });
                }

                if (!errToReport) {
                    errToReport = attempt(() => {
                        const req = this._store.put(item);

                        if (fakedPk) {
                            // If we faked the PK and mutated the incoming object, we can nuke that on the way out.  IndexedDB clones the
                            // object synchronously for the put call, so it's already been captured with the nsp_pk field intact.
                            delete (item as any)['nsp_pk'];
                        }

                        promises.push(IndexedDbProvider.WrapRequest<void>(req));
                    });
                }

                if (errToReport) {
                    promises.push(Promise.reject<void>(errToReport));
                }
            });
        });

        if (err) {
            return Promise.reject<void>(err);
        }

        return Promise.all(promises).then(noop);
    }

    remove(keyOrKeys: KeyType | KeyType[]): Promise<void> {
        const keys = attempt(() => {
            const keys = formListOfKeys(keyOrKeys, this._schema.primaryKeyPath);

            if (this._fakeComplicatedKeys && isCompoundKeyPath(this._schema.primaryKeyPath)) {
                return map(keys, key => serializeKeyToString(key, this._schema.primaryKeyPath));
            }
            return keys;
        });
        if (isError(keys)) {
            return Promise.reject<void>(keys);
        }

        return Promise.all(map(keys, key => {
            if (this._fakeComplicatedKeys && some(this._schema.indexes, index => index.multiEntry || index.fullText)) {
                // If we're faking keys and there's any multientry indexes, we have to do the way more complicated version...
                return IndexedDbProvider.WrapRequest<any>(this._store.get(key)).then(item => {
                    if (item) {
                        // Go through each multiEntry index and nuke the referenced items from the sub-stores
                        let promises = map(filter(this._schema.indexes, index => !!index.multiEntry), index => {
                            let indexStore = find(this._indexStores, store => store.name === this._schema.name + '_' + index.name)!!!;
                            const refKey = attempt(() => {
                                // We need to reference the PK of the actual row we're using here, so calculate the actual PK -- if it's
                                // compound, we're already faking complicated keys, so we know to serialize it to a string.  If not, use the
                                // raw value.
                                const tempRefKey = getKeyForKeypath(item, this._schema.primaryKeyPath)!!!;
                                return isArray(this._schema.primaryKeyPath) ?
                                    serializeKeyToString(tempRefKey, this._schema.primaryKeyPath) :
                                    tempRefKey;
                            });
                            if (isError(refKey)) {
                                return Promise.reject<void>(refKey);
                            }

                            // First clear out the old values from the index store for the refkey
                            const cursorReq = indexStore.index('refkey').openCursor(IDBKeyRange.only(refKey));
                            return IndexedDbIndex.iterateOverCursorRequest(cursorReq, cursor => {
                                cursor['delete']();
                            });
                        });
                        // Also remember to nuke the item from the actual store
                        promises.push(IndexedDbProvider.WrapRequest<void>(this._store['delete'](key)));
                        return Promise.all(promises).then(noop);
                    }
                    return undefined;
                });
            }

            return IndexedDbProvider.WrapRequest<void>(this._store['delete'](key));
        })).then(noop);
    }

    removeRange(indexName: string, 
                keyLowRange: KeyType, 
                keyHighRange: KeyType, 
                lowRangeExclusive?: boolean, 
                highRangeExclusive?: boolean): Promise<void> {
        const index = attempt(() => {
            return indexName ? this.openIndex(indexName) : this.openPrimaryKey();
        });
        if (!index || isError(index)) {
            return Promise.reject<void>('Index "' + indexName + '" not found');
        }                    
        return index.getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).then(keys => {
            this.remove(keys);
        });        
    }    

    openIndex(indexName: string): DbIndex {
        const indexSchema = find(this._schema.indexes, idx => idx.name === indexName);
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }

        if (this._fakeComplicatedKeys && (indexSchema.multiEntry || indexSchema.fullText)) {
            const store = find(this._indexStores, indexStore => indexStore.name === this._schema.name + '_' + indexSchema.name);
            if (!store) {
                throw new Error('Indexstore not found: ' + this._schema.name + '_' + indexSchema.name);
            }
            return new IndexedDbIndex(store.index('key'), indexSchema, this._schema.primaryKeyPath, this._fakeComplicatedKeys,
                this._store);
        } else {
            const index = this._store.index(indexName);
            if (!index) {
                throw new Error('Index store not found: ' + indexName);
            }
            return new IndexedDbIndex(index, indexSchema, this._schema.primaryKeyPath, this._fakeComplicatedKeys);
        }
    }

    openPrimaryKey(): DbIndex {
        return new IndexedDbIndex(this._store, undefined, this._schema.primaryKeyPath, this._fakeComplicatedKeys);
    }

    clearAllData(): Promise<void> {
        let storesToClear = [this._store];
        if (this._indexStores) {
            storesToClear = storesToClear.concat(this._indexStores);
        }

        let promises = map(storesToClear, store => IndexedDbProvider.WrapRequest(store.clear()));

        return Promise.all(promises).then(noop);
    }
}

// DbIndex implementation for the IndexedDB DbProvider.  Fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE and some helpers to make the caller not have to walk the awkward cursor
// result APIs to get their result list.  Also added ability to use an "index" for opening the primary key on a store.
class IndexedDbIndex extends DbIndexFTSFromRangeQueries {
    constructor(private _store: IDBIndex | IDBObjectStore, indexSchema: IndexSchema | undefined,
        primaryKeyPath: KeyPathType, private _fakeComplicatedKeys: boolean, private _fakedOriginalStore?: IDBObjectStore) {
        super(indexSchema, primaryKeyPath);
    }

    private _resolveCursorResult(req: IDBRequest, limit?: number, offset?: number): Promise<ItemType[]> {
        if (this._fakeComplicatedKeys && this._fakedOriginalStore) {
            // Get based on the keys from the index store, which have refkeys that point back to the original store
            return IndexedDbIndex.getFromCursorRequest<{ key: string, refkey: any }>(req, limit, offset).then(rets => {
                // Now get the original items using the refkeys from the index store, which are PKs on the main store
                const getters = map(rets, ret => IndexedDbProvider.WrapRequest(this._fakedOriginalStore!!!.get(ret.refkey)));
                return Promise.all(getters);
            });
        } else {
            return IndexedDbIndex.getFromCursorRequest(req, limit, offset);
        }
    }

    getAll(reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]> {
        const reverse = reverseOrSortOrder === true || reverseOrSortOrder === QuerySortOrder.Reverse;
        if (!reverse && this._store.getAll && !offset && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest(this._store.getAll(undefined, limit));
        }
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        const req = this._store.openCursor(null!!!, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    }

    getOnly(key: KeyType, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number)
        : Promise<ItemType[]> {
        const keyRange = attempt(() => {
            return this._getKeyRangeForOnly(key);
        });
        if (isError(keyRange)) {
            return Promise.reject(keyRange);
        }
        const reverse = reverseOrSortOrder === true || reverseOrSortOrder === QuerySortOrder.Reverse;
        if (!reverse && this._store.getAll && !offset && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest(this._store.getAll(keyRange, limit));
        }
        const req = this._store.openCursor(keyRange, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    }

    getMultiple(keyOrKeys: KeyType | KeyType[])
    : Promise<ItemType[]> {

        const keys = attempt(() => {
            const keys = formListOfKeys(keyOrKeys, this._keyPath);
            return keys;
        });
        if (isError(keys)) {
            return Promise.reject(keys);
        }

        if (this._store.get && !this._fakeComplicatedKeys) {
            return Promise.all<object[]>(map(keys, key => IndexedDbProvider.WrapRequest(this._store.get(key)))).then(compact);
        }

        return Promise.all(map(keys, key => this.getOnly(key))).then(vals => compact(flatten(vals)));
    }
    // Warning: This function can throw, make sure to trap.
    private _getKeyRangeForOnly(key: KeyType): IDBKeyRange {
        if (this._fakeComplicatedKeys && isCompoundKeyPath(this._keyPath)) {
            return IDBKeyRange.only(serializeKeyToString(key, this._keyPath));
        }
        return IDBKeyRange.only(key);
    }

    getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]> {
        const keyRange = attempt(() => {
            return this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (isError(keyRange)) {
            return Promise.reject(keyRange);
        }

        const reverse = reverseOrSortOrder === true || reverseOrSortOrder === QuerySortOrder.Reverse;
        if (!reverse && this._store.getAll && !offset && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest(this._store.getAll(keyRange, limit));
        }
        const req = this._store.openCursor(keyRange, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    }

    // Warning: This function can throw, make sure to trap.
    private _getKeyRangeForRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean,
        highRangeExclusive?: boolean)
        : IDBKeyRange {
        if (this._fakeComplicatedKeys && isCompoundKeyPath(this._keyPath)) {
            // IE has to switch to hacky pre-joined-compound-keys
            return IDBKeyRange.bound(serializeKeyToString(keyLowRange, this._keyPath),
                serializeKeyToString(keyHighRange, this._keyPath),
                lowRangeExclusive, highRangeExclusive);
        }
        return IDBKeyRange.bound(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
    }

    countAll(): Promise<number> {
        const req = this._store.count();
        return this._countRequest(req);
    }

    countOnly(key: KeyType): Promise<number> {
        const keyRange = attempt(() => {
            return this._getKeyRangeForOnly(key);
        });
        if (isError(keyRange)) {
            return Promise.reject(keyRange);
        }

        const req = this._store.count(keyRange);
        return this._countRequest(req);
    }

    countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : Promise<number> {
        let keyRange = attempt(() => {
            return this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (isError(keyRange)) {
            return Promise.reject(keyRange);
        }

        const req = this._store.count(keyRange);
        return this._countRequest(req);
    }

    getKeysForRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : Promise<any[]> {
        const keyRange = attempt(() => {
            return this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (isError(keyRange)) {
            return Promise.reject<string[]>(keyRange);
        }
        if (this._store.getAllKeys && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest<any[]>(this._store.getAllKeys(keyRange));
        }

        let keys: any[] = [];
        let req = this._store.openCursor(keyRange, 'next');
        return IndexedDbIndex.iterateOverCursorRequest(req, cursor => {
            keys.push(cursor.key);
        }).then(() => {
            return keys;            
        });
    }      

    static getFromCursorRequest<T>(req: IDBRequest, limit?: number, offset?: number): Promise<T[]> {
        let outList: T[] = [];
        return this.iterateOverCursorRequest(req, cursor => {
            // Typings on cursor are wrong...
            outList.push((cursor as any).value);
        }, limit, offset).then(() => {
            return outList;
        });
    }

    private _countRequest(req: IDBRequest): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            req.onsuccess = (event) => {
                resolve((<IDBRequest>event.target).result as number);
            };
            req.onerror = (ev) => {
                reject(ev);
            };

        });
    }

    static iterateOverCursorRequest(req: IDBRequest, func: (cursor: IDBCursor) => void, limit?: number, offset?: number)
        : Promise<void> {
        return new Promise((resolve, reject) => {
            let count = 0;
            req.onsuccess = (event) => {
                const cursor: IDBCursor = (<IDBRequest>event.target).result;
                if (cursor) {
                    if (offset) {
                        cursor.advance(offset);
                        offset = 0;
                    } else {
                        func(cursor);
                        count++;
                        if (limit && (count === limit)) {
                            resolve(void 0);
                            return;
                        }
                        cursor['continue']();
                    }
                } else {
                    // Nothing else to iterate
                    resolve(void 0);
                }
            };
            req.onerror = (ev) => {
                reject(ev);
            };
        });
    }
}
