/**
 * IndexedDbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for IndexedDB, a web browser storage module.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import FullTextSearchHelpers = require('./FullTextSearchHelpers');
import NoSqlProvider = require('./NoSqlProvider');
import { ItemType, KeyPathType, KeyType } from './NoSqlProvider';
import NoSqlProviderUtils = require('./NoSqlProviderUtils');
import TransactionLockHelper, { TransactionToken } from './TransactionLockHelper';

const IndexPrefix = 'nsp_i_';

export function isIE() {
    return (typeof (document) !== 'undefined' && document.all !== null && document.documentMode <= 11) ||
        (typeof (navigator) !== 'undefined' && !!navigator.userAgent && navigator.userAgent.indexOf('Edge/') !== -1);
}

// The DbProvider implementation for IndexedDB.  This one is fairly straightforward since the library's access patterns pretty
// closely mirror IndexedDB's.  We mostly do a lot of wrapping of the APIs into JQuery promises and have some fancy footwork to
// do semi-automatic schema upgrades.
export class IndexedDbProvider extends NoSqlProvider.DbProvider {
    private _db: IDBDatabase|undefined;
    private _test: boolean;
    private _dbFactory: IDBFactory;
    private _fakeComplicatedKeys: boolean;

    private _lockHelper: TransactionLockHelper;

    // By default, it uses the in-browser indexed db factory, but you can pass in an explicit factory.  Currently only used for unit tests.
    constructor(explicitDbFactory?: IDBFactory, explicitDbFactorySupportsCompoundKeys?: boolean) {
        super();

        if (explicitDbFactory) {
            this._dbFactory = explicitDbFactory;
            this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
        } else {
            this._dbFactory = window._indexedDB || window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;

            if (typeof explicitDbFactorySupportsCompoundKeys !== 'undefined') {
                this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
            } else {
                // IE/Edge's IndexedDB implementation doesn't support compound keys, so we have to fake it by implementing them similar to
                // how the WebSqlProvider does, by concatenating the values into another field which then gets its own index.
                this._fakeComplicatedKeys = isIE();
            }
        }
    }

    static WrapRequest<T>(req: IDBRequest): SyncTasks.Promise<T> {
        const task = SyncTasks.Defer<T>();

        req.onsuccess = (/*ev*/) => {
            task.resolve(req.result);
        };
        req.onerror = (ev) => {
            task.reject(ev);
        };

        return task.promise();
    }

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        // Note: DbProvider returns null instead of a promise that needs waiting for.
        super.open(dbName, schema, wipeIfExists, verbose);

        if (!this._dbFactory) {
            // Couldn't even find a supported indexeddb object on the browser...
            return SyncTasks.Rejected<void>('No support for IndexedDB in this browser');
        }

        if (!this._test && typeof (navigator) !== 'undefined' && ((navigator.userAgent.indexOf('Safari') !== -1 &&
            navigator.userAgent.indexOf('Chrome') === -1 && navigator.userAgent.indexOf('BB10') === -1) ||
            (navigator.userAgent.indexOf('Mobile Crosswalk') !== -1))) {
            // Safari doesn't support indexeddb properly, so don't let it try
            // Android crosswalk indexeddb is slow, don't use it
            return SyncTasks.Rejected<void>('Safari doesn\'t properly implement IndexedDB');
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

        let migrationPutters: SyncTasks.Promise<void>[] = [];

        dbOpen.onupgradeneeded = (event) => {
            const db: IDBDatabase = dbOpen.result;
            const target = <IDBOpenDBRequest>(event.currentTarget || event.target);
            const trans = target.transaction;

            if (schema.lastUsableVersion && event.oldVersion < schema.lastUsableVersion) {
                // Clear all stores if it's past the usable version
                console.log('Old version detected (' + event.oldVersion + '), clearing all data');
                _.each(db.objectStoreNames, name => {
                    db.deleteObjectStore(name);
                });
            }

            // Delete dead stores
            _.each(db.objectStoreNames, storeName => {
                if (!_.some(schema.stores, store => store.name === storeName)) {
                    db.deleteObjectStore(storeName);
                }
            });

            // Create all stores
            _.each(schema.stores, storeSchema => {
                let store: IDBObjectStore;
                let migrateData = false;
                if (!_.includes(db.objectStoreNames, storeSchema.name)) {
                    let primaryKeyPath = storeSchema.primaryKeyPath;
                    if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(primaryKeyPath)) {
                        // Going to have to hack the compound primary key index into a column, so here it is.
                        primaryKeyPath = 'nsp_pk';
                    }

                    // Any is to fix a lib.d.ts issue in TS 2.0.3 - it doesn't realize that keypaths can be compound for some reason...
                    store = db.createObjectStore(storeSchema.name, { keyPath: primaryKeyPath } as any);
                } else {
                    store = trans.objectStore(storeSchema.name);
                    migrateData = true;

                    // Check for any indexes no longer in the schema or have been changed
                    _.each(store.indexNames, indexName => {
                        const index = store.index(indexName);

                        let nuke = false;
                        const indexSchema = _.find(storeSchema.indexes, idx => idx.name === indexName);
                        if (!indexSchema || !_.isObject(indexSchema)) {
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

                // Check any indexes in the schema that need to be created
                let needsMigrate = false;
                _.each(storeSchema.indexes, indexSchema => {
                    if (!_.includes(store.indexNames, indexSchema.name)) {
                        const keyPath = indexSchema.keyPath;
                        if (this._fakeComplicatedKeys) {
                            if (indexSchema.multiEntry || indexSchema.fullText) {
                                if (NoSqlProviderUtils.isCompoundKeyPath(keyPath)) {
                                    throw new Error('Can\'t use multiEntry and compound keys');
                                } else {
                                    // Create an object store for the index
                                    let indexStore = db.createObjectStore(storeSchema.name + '_' + indexSchema.name,
                                        { autoIncrement: true });
                                    indexStore.createIndex('key', 'key');
                                    indexStore.createIndex('refkey', 'refkey');

                                    if (migrateData) {
                                        needsMigrate = true;
                                    }
                                }
                            } else if (NoSqlProviderUtils.isCompoundKeyPath(keyPath)) {
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

                            if (migrateData) {
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
                        storeNames: [ storeSchema.name ],
                        exclusive: false,
                        completionPromise: SyncTasks.Defer<void>().promise()
                    };
                    const iTrans = new IndexedDbTransaction(trans, undefined, fakeToken, schema, this._fakeComplicatedKeys);
                    const tStore = iTrans.getStore(storeSchema.name);

                    const cursorReq = store.openCursor();
                    let thisIndexPutters: SyncTasks.Promise<void>[] = [];
                    migrationPutters.push(IndexedDbIndex.iterateOverCursorRequest(cursorReq, cursor => {
                        const err = _.attempt(() => {
                            const item = removeFullTextMetadataAndReturn(storeSchema, (cursor as any).value);

                            thisIndexPutters.push(tStore.put(item));
                        });
                        if (err) {
                            thisIndexPutters.push(SyncTasks.Rejected<void>(err));
                        }
                    }).then(() => SyncTasks.all(thisIndexPutters).then(_.noop)));
                }
            });
        };

        const promise = IndexedDbProvider.WrapRequest<IDBDatabase>(dbOpen);

        return promise.then(db => {
            return SyncTasks.all(migrationPutters).then(() => {
                this._db = db;
            });
        }, err => {
            if (err && err.type === 'error' && err.target && err.target.error && err.target.error.name === 'VersionError') {
                if (!wipeIfExists) {
                    console.log('Database version too new, Wiping: ' + (err.target.error.message || err.target.error.name));

                    return this.open(dbName, schema, true, verbose);
                }
            }
            return SyncTasks.Rejected<void>(err);
        });
    }

    close(): SyncTasks.Promise<void> {
        if (!this._db) {
            return SyncTasks.Rejected('Database already closed');
        }

        this._db.close();
        this._db = undefined;
        return SyncTasks.Resolved<void>();
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction> {
        if (!this._db) {
            return SyncTasks.Rejected('Can\'t openTransaction, database is closed');
        }

        let intStoreNames = storeNames;

        if (this._fakeComplicatedKeys) {
            // Clone the list becuase we're going to add fake store names to it
            intStoreNames = _.clone(storeNames);

            // Pull the alternate multientry stores into the transaction as well
            let missingStores: string[] = [];
            _.each(storeNames, storeName => {
                let storeSchema = _.find(this._schema.stores, s => s.name === storeName);
                if (!storeSchema) {
                    missingStores.push(storeName);
                    return;
                }
                if (storeSchema.indexes) {
                    _.each(storeSchema.indexes, indexSchema => {
                        if (indexSchema.multiEntry || indexSchema.fullText) {
                            intStoreNames.push(storeSchema!!!.name + '_' + indexSchema.name);
                        }
                    });
                }
            });
            if (missingStores.length > 0) {
                return SyncTasks.Rejected('Can\'t find store(s): ' + missingStores.join(','));
            }
        }

        return this._lockHelper.openTransaction(storeNames, writeNeeded).then(transToken => {
            let trans: IDBTransaction;
            const err = _.attempt(() => {
                trans = this._db!!!.transaction(intStoreNames, writeNeeded ? 'readwrite' : 'readonly');
            });
            if (err) {
                return SyncTasks.Rejected(err);
            }

            return new IndexedDbTransaction(trans!!!, this._lockHelper, transToken, this._schema, this._fakeComplicatedKeys);
        });
    }
}

// DbTransaction implementation for the IndexedDB DbProvider.
class IndexedDbTransaction implements NoSqlProvider.DbTransaction {
    private _stores: IDBObjectStore[];

    constructor(private _trans: IDBTransaction, lockHelper: TransactionLockHelper|undefined, private _transToken: TransactionToken,
            private _schema: NoSqlProvider.DbSchema, private _fakeComplicatedKeys: boolean) {
        this._stores = _.map(this._transToken.storeNames, storeName => this._trans.objectStore(storeName));

        if (lockHelper) {
            let hasCompleted = false;
            this._trans.oncomplete = () => {
                hasCompleted = true;
                lockHelper.transactionComplete(this._transToken);
            };

            this._trans.onerror = () => {
                lockHelper.transactionFailed(this._transToken, 'IndexedDbTransaction OnError: ' +
                    (this._trans.error ? this._trans.error.message : undefined));
            };

            this._trans.onabort = () => {
                if (hasCompleted && this._trans.error.message === 'Transaction timed out due to inactivity.') {
                    // Chromium seems to have a bug in their indexeddb implementation that lets it start a timeout
                    // while the app is in the middle of a commit (it does a two-phase commit).  It can then finish
                    // the commit, and later fire the timeout, despite the transaction having been written out already.
                    // In this case, it appears that we should be completely fine to ignore the spurious timeout.
                    //
                    // Applicable Chromium source code here:
                    // https://chromium.googlesource.com/chromium/src/+/master/content/browser/indexed_db/indexed_db_transaction.cc
                    
                    console.warn('Swallowed a transaction timeout warning after completion from IndexedDb');
                } else {
                    lockHelper.transactionFailed(this._transToken, 'IndexedDbTransaction Aborted, Error: ' +
                        (this._trans.error ? this._trans.error.message : undefined));
                }
            };
        }
    }

    getStore(storeName: string): NoSqlProvider.DbStore {
        const store = _.find(this._stores, s => s.name === storeName);
        const storeSchema = _.find(this._schema.stores, s => s.name === storeName);
        if (!store || !storeSchema) {
            throw new Error('Store not found: ' + storeName);
        }

        const indexStores: IDBObjectStore[] = [];
        if (this._fakeComplicatedKeys && storeSchema.indexes) {
            // Pull the alternate multientry stores in as well
            _.each(storeSchema.indexes, indexSchema => {
                if (indexSchema.multiEntry || indexSchema.fullText) {
                    indexStores.push(this._trans.objectStore(storeSchema.name + '_' + indexSchema.name));
                }
            });
        }

        return new IndexedDbStore(store, indexStores, storeSchema, this._fakeComplicatedKeys);
    }

    getCompletionPromise(): SyncTasks.Promise<void> {
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

function removeFullTextMetadataAndReturn<T>(schema: NoSqlProvider.StoreSchema, val: T): T {
    if (val) {
        // We have full text index fields as real fields on the result, so nuke them before returning them to the caller.
        _.each(schema.indexes, index => {
            if (index.fullText) {
                delete (val as any)[IndexPrefix + index.name];
            }
        });
    }

    return val;
}

// DbStore implementation for the IndexedDB DbProvider.  Again, fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE.
class IndexedDbStore implements NoSqlProvider.DbStore {
    constructor(private _store: IDBObjectStore, private _indexStores: IDBObjectStore[], private _schema: NoSqlProvider.StoreSchema,
            private _fakeComplicatedKeys: boolean) {
        // NOP
    }

    get(key: KeyType): SyncTasks.Promise<ItemType|undefined> {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._schema.primaryKeyPath)) {
            const err = _.attempt(() => {
                key = NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath);
            });
            if (err) {
                return SyncTasks.Rejected(err);
            }
        }

        return IndexedDbProvider.WrapRequest(this._store.get(key))
            .then(val => removeFullTextMetadataAndReturn(this._schema, val));
    }

    getMultiple(keyOrKeys: KeyType|KeyType[]): SyncTasks.Promise<ItemType[]> {
        let keys: any[];
        const err = _.attempt(() => {
            keys = NoSqlProviderUtils.formListOfKeys(keyOrKeys, this._schema.primaryKeyPath);

            if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._schema.primaryKeyPath)) {
                keys = _.map(keys, key => NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath));
            }
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        // There isn't a more optimized way to do this with indexeddb, have to get the results one by one
        return SyncTasks.all(_.map(keys!!!, key =>
            IndexedDbProvider.WrapRequest(this._store.get(key)).then(val => removeFullTextMetadataAndReturn(this._schema, val))))
            .then(_.compact);
    }

    put(itemOrItems: ItemType|ItemType[]): SyncTasks.Promise<void> {
        let items = NoSqlProviderUtils.arrayify(itemOrItems);

        let promises: SyncTasks.Promise<void>[] = [];

        const err = _.attempt(() => {
            _.each(items, item => {
                let errToReport: any;
                let fakedPk = false;

                if (this._fakeComplicatedKeys) {
                    // Fill out any compound-key indexes
                    if (NoSqlProviderUtils.isCompoundKeyPath(this._schema.primaryKeyPath)) {
                        fakedPk = true;
                        (item as any)['nsp_pk'] = NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._schema.primaryKeyPath);
                    }

                    _.each(this._schema.indexes, index => {
                        if (index.multiEntry || index.fullText) {
                            let indexStore = _.find(this._indexStores, store => store.name === this._schema.name + '_' + index.name)!!!;

                            let keys: any[];
                            if (index.fullText) {
                                keys = FullTextSearchHelpers.getFullTextIndexWordsForItem(<string>index.keyPath, item);
                            } else {
                                // Get each value of the multientry and put it into the index store
                                const valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, <string>index.keyPath);
                                // It might be an array of multiple entries, so just always go with array-based logic
                                keys = NoSqlProviderUtils.arrayify(valsRaw);
                            }

                            let refKey: any;
                            const err = _.attempt(() => {
                                // We're using normal indexeddb tables to store the multientry indexes, so we only need to use the key
                                // serialization if the multientry keys ALSO are compound.
                                if (NoSqlProviderUtils.isCompoundKeyPath(index.keyPath)) {
                                    keys = _.map(keys, val => NoSqlProviderUtils.serializeKeyToString(val, <string>index.keyPath));
                                }

                                // We need to reference the PK of the actual row we're using here, so calculate the actual PK -- if it's
                                // compound, we're already faking complicated keys, so we know to serialize it to a string.  If not, use the
                                // raw value.
                                refKey = NoSqlProviderUtils.getKeyForKeypath(item, this._schema.primaryKeyPath);
                                if (_.isArray(this._schema.primaryKeyPath)) {
                                    refKey = NoSqlProviderUtils.serializeKeyToString(refKey, this._schema.primaryKeyPath);
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
                                    let iputters = _.map(keys, key => {
                                        const indexObj = {
                                            key: key,
                                            refkey: refKey
                                        };
                                        return IndexedDbProvider.WrapRequest<void>(indexStore.put(indexObj));
                                    });
                                    return SyncTasks.all(iputters);
                                }).then(_.noop));
                        } else if (NoSqlProviderUtils.isCompoundKeyPath(index.keyPath)) {
                            (item as any)[IndexPrefix + index.name] = NoSqlProviderUtils.getSerializedKeyForKeypath(item, index.keyPath);
                        }
                        return true;
                    });
                } else {
                    _.each(this._schema.indexes, index => {
                        if (index.fullText) {
                            (item as any)[IndexPrefix + index.name] =
                                FullTextSearchHelpers.getFullTextIndexWordsForItem(<string>index.keyPath, item);
                        }
                    });
                }

                if (!errToReport) {
                    errToReport = _.attempt(() => {
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
                    promises.push(SyncTasks.Rejected<void>(errToReport));
                }
            });
        });

        if (err) {
            return SyncTasks.Rejected<void>(err);
        }

        return SyncTasks.all(promises).then(_.noop);
    }

    remove(keyOrKeys: KeyType|KeyType[]): SyncTasks.Promise<void> {
        let keys: any[];
        const err = _.attempt(() => {
            keys = NoSqlProviderUtils.formListOfKeys(keyOrKeys, this._schema.primaryKeyPath);

            if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._schema.primaryKeyPath)) {
                keys = _.map(keys, key => NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath));
            }
        });
        if (err) {
            return SyncTasks.Rejected<void>(err);
        }

        return SyncTasks.all(_.map(keys!!!, key => {
            if (this._fakeComplicatedKeys && _.some(this._schema.indexes, index => index.multiEntry || index.fullText)) {
                // If we're faking keys and there's any multientry indexes, we have to do the way more complicated version...
                return IndexedDbProvider.WrapRequest<any>(this._store.get(key)).then(item => {
                    if (item) {
                        // Go through each multiEntry index and nuke the referenced items from the sub-stores
                        let promises = _.map(_.filter(this._schema.indexes, index => !!index.multiEntry), index => {
                            let indexStore = _.find(this._indexStores, store => store.name === this._schema.name + '_' + index.name)!!!;

                            let refKey: KeyType;
                            const err = _.attempt(() => {

                                // We need to reference the PK of the actual row we're using here, so calculate the actual PK -- if it's
                                // compound, we're already faking complicated keys, so we know to serialize it to a string.  If not, use the
                                // raw value.
                                const tempRefKey = NoSqlProviderUtils.getKeyForKeypath(item, this._schema.primaryKeyPath)!!!;
                                refKey = _.isArray(this._schema.primaryKeyPath) ? 
                                    NoSqlProviderUtils.serializeKeyToString(tempRefKey, this._schema.primaryKeyPath) :
                                    tempRefKey;
                            });
                            if (err) {
                                return SyncTasks.Rejected<void>(err);
                            }

                            // First clear out the old values from the index store for the refkey
                            const cursorReq = indexStore.index('refkey').openCursor(IDBKeyRange.only(refKey!!!));
                            return IndexedDbIndex.iterateOverCursorRequest(cursorReq, cursor => {
                                cursor['delete']();
                            });
                        });
                        // Also remember to nuke the item from the actual store
                        promises.push(IndexedDbProvider.WrapRequest<void>(this._store['delete'](key)));
                        return SyncTasks.all(promises).then(_.noop);
                    }
                    return undefined;
                });
            }

            return IndexedDbProvider.WrapRequest<void>(this._store['delete'](key));
        })).then(_.noop);
    }

    openIndex(indexName: string): NoSqlProvider.DbIndex {
        const indexSchema = _.find(this._schema.indexes, idx => idx.name === indexName);
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }

        if (this._fakeComplicatedKeys && (indexSchema.multiEntry || indexSchema.fullText)) {
            const store = _.find(this._indexStores, indexStore => indexStore.name === this._schema.name + '_' + indexSchema.name);
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

    openPrimaryKey(): NoSqlProvider.DbIndex {
        return new IndexedDbIndex(this._store, undefined, this._schema.primaryKeyPath, this._fakeComplicatedKeys);
    }

    clearAllData(): SyncTasks.Promise<void> {
        let storesToClear = [this._store];
        if (this._indexStores) {
            storesToClear = storesToClear.concat(this._indexStores);
        }

        let promises = _.map(storesToClear, store => IndexedDbProvider.WrapRequest(store.clear()));

        return SyncTasks.all(promises).then(_.noop);
    }
}

// DbIndex implementation for the IndexedDB DbProvider.  Fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE and some helpers to make the caller not have to walk the awkward cursor
// result APIs to get their result list.  Also added ability to use an "index" for opening the primary key on a store.
class IndexedDbIndex extends FullTextSearchHelpers.DbIndexFTSFromRangeQueries {
    constructor(private _store: IDBIndex | IDBObjectStore, indexSchema: NoSqlProvider.IndexSchema|undefined,
            primaryKeyPath: KeyPathType, private _fakeComplicatedKeys: boolean, private _fakedOriginalStore?: IDBObjectStore) {
        super(indexSchema, primaryKeyPath);
    }

    private _resolveCursorResult(req: IDBRequest, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]> {
        if (this._fakeComplicatedKeys && this._fakedOriginalStore) {
            // Get based on the keys from the index store, which have refkeys that point back to the original store
            return IndexedDbIndex.getFromCursorRequest<{ key: string, refkey: any }>(req, limit, offset).then(rets => {
                // Now get the original items using the refkeys from the index store, which are PKs on the main store
                const getters = _.map(rets, ret => IndexedDbProvider.WrapRequest(this._fakedOriginalStore!!!.get(ret.refkey)));
                return SyncTasks.all(getters);
            });
        } else {
            return IndexedDbIndex.getFromCursorRequest(req, limit, offset);
        }
    }

    getAll(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]> {
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        const req = this._store.openCursor(null!!!, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    }

    getOnly(key: KeyType, reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]> {
        let keyRange: any;
        const err = _.attempt(() => {
            keyRange = this._getKeyRangeForOnly(key);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        const req = this._store.openCursor(keyRange, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    }

    // Warning: This function can throw, make sure to trap.
    private _getKeyRangeForOnly(key: KeyType): IDBKeyRange {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._keyPath)) {
            return IDBKeyRange.only(NoSqlProviderUtils.serializeKeyToString(key, this._keyPath));
        }
        return IDBKeyRange.only(key);
    }

    getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
            reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]> {
        let keyRange: any;
        const err = _.attempt(() => {
            keyRange = this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        const req = this._store.openCursor(keyRange, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    }

    // Warning: This function can throw, make sure to trap.
    private _getKeyRangeForRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean,
                highRangeExclusive?: boolean)
            : IDBKeyRange {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._keyPath)) {
            // IE has to switch to hacky pre-joined-compound-keys
            return IDBKeyRange.bound(NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath),
                NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath),
                lowRangeExclusive, highRangeExclusive);
        }
        return IDBKeyRange.bound(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
    }

    countAll(): SyncTasks.Promise<number> {
        const req = this._store.count();
        return this._countRequest(req);
    }

    countOnly(key: KeyType): SyncTasks.Promise<number> {
        let keyRange: any;
        const err = _.attempt(() => {
            keyRange = this._getKeyRangeForOnly(key);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        const req = this._store.count(keyRange);
        return this._countRequest(req);
    }

    countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
            : SyncTasks.Promise<number> {
        let keyRange: any;
        const err = _.attempt(() => {
            keyRange = this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        const req = this._store.count(keyRange);
        return this._countRequest(req);
    }

    static getFromCursorRequest<T>(req: IDBRequest, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        let outList: T[] = [];
        return this.iterateOverCursorRequest(req, cursor => {
            // Typings on cursor are wrong...
            outList.push((cursor as any).value);
        }, limit, offset).then(() => {
            return outList;
        });
    }

    private _countRequest(req: IDBRequest): SyncTasks.Promise<number> {
        const deferred = SyncTasks.Defer<number>();

        req.onsuccess = (event) => {
            deferred.resolve((<IDBRequest>event.target).result as number);
        };
        req.onerror = (ev) => {
            deferred.reject(ev);
        };

        return deferred.promise();
    }

    static iterateOverCursorRequest(req: IDBRequest, func: (cursor: IDBCursor) => void, limit?: number, offset?: number)
            : SyncTasks.Promise<void> {
        const deferred = SyncTasks.Defer<void>();

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
                        deferred.resolve();
                        return;
                    }
                    cursor['continue']();
                }
            } else {
                // Nothing else to iterate
                deferred.resolve();
            }
        };
        req.onerror = (ev) => {
            deferred.reject(ev);
        };

        return deferred.promise();
    }
}
