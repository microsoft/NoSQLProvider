/**
 * IndexedDbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for IndexedDB, a web browser storage module.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import NoSqlProviderUtils = require('./NoSqlProviderUtils');

// The DbProvider implementation for IndexedDB.  This one is fairly straightforward since the library's access patterns pretty
// closely mirror IndexedDB's.  We mostly do a lot of wrapping of the APIs into JQuery promises and have some fancy footwork to
// do semi-automatic schema upgrades.
export class IndexedDbProvider extends NoSqlProvider.DbProvider {
    private _db: IDBDatabase;
    private _test: boolean;
    private _dbFactory: IDBFactory;
    private _fakeComplicatedKeys: boolean;

    // By default, it uses the in-browser indexed db factory, but you can pass in an explicit factory.  Currently only used for unit tests.
    constructor(explicitDbFactory?: IDBFactory, explicitDbFactorySupportsCompoundKeys?: boolean) {
        super();

        if (explicitDbFactory) {
            this._dbFactory = explicitDbFactory;
            this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
        } else {
            this._dbFactory = window._indexedDB || window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;

            // IE/Edge's IndexedDB implementation doesn't support compound keys, so we have to fake it by implementing them similar to how
            // the WebSqlProvider does, by concatenating the values into another field which then gets its own index.
            let isIE = NoSqlProviderUtils.isIE();

            if (typeof explicitDbFactorySupportsCompoundKeys !== 'undefined') {
                this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
            } else {
                this._fakeComplicatedKeys = isIE;
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

        var dbOpen = this._dbFactory.open(dbName, schema.version);

        let migrationPutters: SyncTasks.Promise<void>[] = [];

        dbOpen.onupgradeneeded = (event) => {
            var db: IDBDatabase = dbOpen.result;
            var target = <IDBOpenDBRequest>(event.currentTarget || event.target);

            if (schema.lastUsableVersion && event.oldVersion < schema.lastUsableVersion) {
                // Clear all stores if it's past the usable version
                console.log('Old version detected (' + event.oldVersion + '), clearing all data');
                _.each(db.objectStoreNames, name => {
                    db.deleteObjectStore(name);
                });
            }

            // Delete dead stores
            _.each(db.objectStoreNames, storeName => {
                if (!_.any(schema.stores, store => store.name === storeName)) {
                    db.deleteObjectStore(storeName);
                }
            });

            // Create all stores
            _.each(schema.stores, storeSchema => {
                let store: IDBObjectStore = null;
                let migrateData = false;
                if (!_.contains(db.objectStoreNames, storeSchema.name)) {
                    var primaryKeyPath = storeSchema.primaryKeyPath;
                    if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(primaryKeyPath)) {
                        // Going to have to hack the compound primary key index into a column, so here it is.
                        primaryKeyPath = 'nsp_pk';
                    }

                    // Any is to fix a lib.d.ts issue in TS 2.0.3 - it doesn't realize that keypaths can be compound for some reason...
                    store = db.createObjectStore(storeSchema.name, { keyPath: primaryKeyPath } as any);
                } else {
                    store = target.transaction.objectStore(storeSchema.name);
                    migrateData = true;

                    // Check for any indexes no longer in the schema or have been changed
                    _.each(store.indexNames, indexName => {
                        var index = store.index(indexName);

                        var nuke = false;
                        var indexSchema = _.find(storeSchema.indexes, idx => idx.name === indexName);
                        if (!_.isObject(indexSchema)) {
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
                            for (var i = 0; i < index.keyPath.length; i++) {
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
                _.each(storeSchema.indexes, indexSchema => {
                    if (!_.contains(store.indexNames, indexSchema.name)) {
                        var keyPath = indexSchema.keyPath;
                        if (this._fakeComplicatedKeys) {
                            if (indexSchema.multiEntry) {
                                if (NoSqlProviderUtils.isCompoundKeyPath(keyPath)) {
                                    throw 'Can\'t use multiEntry and compound keys';
                                } else {
                                    // Create an object store for the index
                                    let indexStore = db.createObjectStore(storeSchema.name + '_' + indexSchema.name, { keyPath: 'key' });
                                    indexStore.createIndex('key', 'key');
                                    indexStore.createIndex('refkey', 'refkey');

                                    if (migrateData) {
                                        // Walk every element in the store and re-put it to fill out the new index.
                                        var cursorReq = store.openCursor();
                                        let thisIndexPutters: SyncTasks.Promise<void>[] = [];
                                        migrationPutters.push(IndexedDbIndex.iterateOverCursorRequest(cursorReq, cursor => {
                                            let item = cursor.value;

                                            // Get each value of the multientry and put it into the index store
                                            let valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, <string>indexSchema.keyPath);
                                            // It might be an array of multiple entries, so just always go with array-based logic
                                            let vals = NoSqlProviderUtils.arrayify(valsRaw);

                                            let refKey = NoSqlProviderUtils.getSerializedKeyForKeypath(item,
                                                storeSchema.primaryKeyPath);

                                            // After nuking the existing entries, add the new ones
                                            _.each(vals, val => {
                                                var indexObj = {
                                                    key: val,
                                                    refkey: refKey
                                                };
                                                thisIndexPutters.push(IndexedDbProvider.WrapRequest<void>(indexStore.put(indexObj)));
                                            });
                                        }).then(() => SyncTasks.all(thisIndexPutters).then(() => void 0)));
                                    }
                                }
                            } else if (NoSqlProviderUtils.isCompoundKeyPath(keyPath)) {
                                // Going to have to hack the compound index into a column, so here it is.
                                store.createIndex(indexSchema.name, 'nsp_i_' + indexSchema.name, {
                                    unique: indexSchema.unique
                                });
                            } else {
                                store.createIndex(indexSchema.name, keyPath, {
                                    unique: indexSchema.unique
                                });
                            }
                        } else {
                            store.createIndex(indexSchema.name, keyPath, {
                                unique: indexSchema.unique,
                                multiEntry: indexSchema.multiEntry
                            });
                        }
                    }
                });
            });
        };

        var promise = IndexedDbProvider.WrapRequest<IDBDatabase>(dbOpen);

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
        this._db.close();
        this._db = null;
        return SyncTasks.Resolved<void>();
    }

    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction> {
        // Clone the list becuase we're going to add fake store names to it
        let intStoreNames = NoSqlProviderUtils.arrayify(_.clone(storeNames));

        if (this._fakeComplicatedKeys) {
            // Pull the alternate multientry stores into the transaction as well
            let missingStores: string[] = [];
            _.each(intStoreNames, storeName => {
                let storeSchema = _.find(this._schema.stores, s => s.name === storeName);
                if (!storeSchema) {
                    missingStores.push(storeName);
                    return;
                }
                if (storeSchema.indexes) {
                    _.each(storeSchema.indexes, indexSchema => {
                        if (indexSchema.multiEntry) {
                            intStoreNames.push(storeSchema.name + '_' + indexSchema.name);
                        }
                    });
                }
            });
            if (missingStores.length > 0) {
                return SyncTasks.Rejected('Can\'t find store(s): ' + missingStores.join(','));
            }
        }

        try {
            let trans = this._db.transaction(intStoreNames, writeNeeded ? 'readwrite' : 'readonly');
            var ourTrans = new IndexedDbTransaction(trans, this._schema, intStoreNames, this._fakeComplicatedKeys);
            return SyncTasks.Resolved<NoSqlProvider.DbTransaction>(ourTrans);
        } catch (e) {
            return SyncTasks.Rejected(e);
        }
    }
}

// DbTransaction implementation for the IndexedDB DbProvider.
class IndexedDbTransaction implements NoSqlProvider.DbTransaction {
    private _trans: IDBTransaction;
    private _stores: IDBObjectStore[];
    private _schema: NoSqlProvider.DbSchema;
    private _fakeComplicatedKeys: boolean;

    constructor(trans: IDBTransaction, schema: NoSqlProvider.DbSchema, storeNames: string[], fakeComplicatedKeys: boolean) {
        this._trans = trans;
        this._schema = schema;
        this._fakeComplicatedKeys = fakeComplicatedKeys;

        this._stores = _.map(storeNames, storeName => this._trans.objectStore(storeName));
    }

    getStore(storeName: string): NoSqlProvider.DbStore {
        var store = _.find(this._stores, s => s.name === storeName);
        var storeSchema = _.find(this._schema.stores, s => s.name === storeName);
        if (store === void 0 || storeSchema === void 0) {
            return null;
        }

        var indexStores: IDBObjectStore[] = [];
        if (this._fakeComplicatedKeys && storeSchema.indexes) {
            // Pull the alternate multientry stores in as well
            _.each(storeSchema.indexes, indexSchema => {
                if (indexSchema.multiEntry) {
                    indexStores.push(this._trans.objectStore(storeSchema.name + '_' + indexSchema.name));
                }
            });
        }

        return new IndexedDbStore(store, indexStores, storeSchema, this._fakeComplicatedKeys);
    }
}

// DbStore implementation for the IndexedDB DbProvider.  Again, fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE.
class IndexedDbStore implements NoSqlProvider.DbStore {
    private _store: IDBObjectStore;
    private _indexStores: IDBObjectStore[];
    private _schema: NoSqlProvider.StoreSchema;
    private _fakeComplicatedKeys: boolean;

    constructor(store: IDBObjectStore, indexStores: IDBObjectStore[], schema: NoSqlProvider.StoreSchema, fakeComplicatedKeys: boolean) {
        this._store = store;
        this._indexStores = indexStores;
        this._schema = schema;
        this._fakeComplicatedKeys = fakeComplicatedKeys;
    }

    get<T>(key: any | any[]): SyncTasks.Promise<T> {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._schema.primaryKeyPath)) {
            key = NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath);
        }

        return IndexedDbProvider.WrapRequest<T>(this._store.get(key));
    }

    getMultiple<T>(keyOrKeys: any | any[]): SyncTasks.Promise<T[]> {
        let keys = NoSqlProviderUtils.formListOfKeys(keyOrKeys, this._schema.primaryKeyPath);

        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._schema.primaryKeyPath)) {
            keys = _.map(keys, key => NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath));
        }

        // There isn't a more optimized way to do this with indexeddb, have to get the results one by one
        return SyncTasks.all(_.map(keys, key => IndexedDbProvider.WrapRequest<T>(this._store.get(key))));
    }

    put(itemOrItems: any | any[]): SyncTasks.Promise<void> {
        let items = NoSqlProviderUtils.arrayify(itemOrItems);

        let promises: SyncTasks.Promise<void>[] = [];

        _.each(items, item => {
            if (this._fakeComplicatedKeys) {
                // Fill out any compound-key indexes
                if (NoSqlProviderUtils.isCompoundKeyPath(this._schema.primaryKeyPath)) {
                    item['nsp_pk'] = NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._schema.primaryKeyPath);
                }

                _.each(this._schema.indexes, index => {
                    if (index.multiEntry) {
                        let indexStore = _.find(this._indexStores, store => store.name === this._schema.name + '_' + index.name);

                        // Get each value of the multientry and put it into the index store
                        const valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, <string>index.keyPath);
                        // It might be an array of multiple entries, so just always go with array-based logic
                        const valsArray = NoSqlProviderUtils.arrayify(valsRaw);

                        let keys = valsArray;
                        // We're using normal indexeddb tables to store the multientry indexes, so we only need to use the key
                        // serialization if the multientry keys ALSO are compound.
                        if (NoSqlProviderUtils.isCompoundKeyPath(index.keyPath)) {
                            keys = _.map(keys, val => NoSqlProviderUtils.serializeKeyToString(val, <string>index.keyPath));
                        }

                        // We need to reference the PK of the actual row we're using here, so calculate the actual PK -- if it's 
                        // compound, we're already faking complicated keys, so we know to serialize it to a string.  If not, use the
                        // raw value.
                        let refKey = NoSqlProviderUtils.getKeyForKeypath(item, this._schema.primaryKeyPath);
                        if (_.isArray(this._schema.primaryKeyPath)) {
                            refKey = NoSqlProviderUtils.serializeKeyToString(refKey, this._schema.primaryKeyPath);
                        }

                        // First clear out the old values from the index store for the refkey
                        var cursorReq = indexStore.index('refkey').openCursor(IDBKeyRange.only(refKey));
                        promises.push(IndexedDbIndex.iterateOverCursorRequest(cursorReq, cursor => {
                            cursor['delete']();
                        })
                            .then(() => {
                                // After nuking the existing entries, add the new ones
                                let iputters = _.map(keys, key => {
                                    var indexObj = {
                                        key: key,
                                        refkey: refKey
                                    };
                                    return IndexedDbProvider.WrapRequest<void>(indexStore.put(indexObj));
                                });
                                return SyncTasks.all(iputters);
                            }).then(rets => void 0));
                    } else if (NoSqlProviderUtils.isCompoundKeyPath(index.keyPath)) {
                        item['nsp_i_' + index.name] = NoSqlProviderUtils.getSerializedKeyForKeypath(item, index.keyPath);
                    }
                });
            }

            let promise: SyncTasks.Promise<void>;
            try {
                promise = IndexedDbProvider.WrapRequest<void>(this._store.put(item)); 
            } catch (e) {
                promise = SyncTasks.Rejected<void>(e);
            }

            promises.push(promise);
        });

        return SyncTasks.all(promises).then(rets => void 0);
    }

    remove(keyOrKeys: any | any[]): SyncTasks.Promise<void> {
        var keys = NoSqlProviderUtils.formListOfKeys(keyOrKeys, this._schema.primaryKeyPath);

        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._schema.primaryKeyPath)) {
            keys = _.map(keys, key => NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath));
        }

        return SyncTasks.all(_.map(keys, key => {
            if (this._fakeComplicatedKeys && _.any(this._schema.indexes, index => index.multiEntry)) {
                // If we're faking keys and there's any multientry indexes, we have to do the way more complicated version...
                return IndexedDbProvider.WrapRequest<any>(this._store.get(key)).then(item => {
                    if (item) {
                        // Go through each multiEntry index and nuke the referenced items from the sub-stores
                        let promises = _.map(_.filter(this._schema.indexes, index => index.multiEntry), index => {
                            let indexStore = _.find(this._indexStores, store => store.name === this._schema.name + '_' + index.name);

                            let refKey = NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._schema.primaryKeyPath);

                            // First clear out the old values from the index store for the refkey
                            var cursorReq = indexStore.index('refkey').openCursor(IDBKeyRange.only(refKey));
                            return IndexedDbIndex.iterateOverCursorRequest(cursorReq, cursor => {
                                cursor['delete']();
                            });
                        });
                        // Also remember to nuke the item from the actual store
                        promises.push(IndexedDbProvider.WrapRequest<void>(this._store['delete'](key)));
                        return SyncTasks.all(promises).then(_.noop);
                    }
                });
            }

            return IndexedDbProvider.WrapRequest<void>(this._store['delete'](key));
        })).then(rets => void 0);
    }

    openIndex(indexName: string): NoSqlProvider.DbIndex {
        let indexSchema = _.find(this._schema.indexes, idx => idx.name === indexName);
        if (indexSchema === void 0) {
            return null;
        }

        if (this._fakeComplicatedKeys && indexSchema.multiEntry) {
            let store = _.find(this._indexStores, indexStore => indexStore.name === this._schema.name + '_' + indexSchema.name);
            if (store === void 0) {
                return null;
            }
            return new IndexedDbIndex(store.index('key'), indexSchema.keyPath, this._fakeComplicatedKeys, this._store);
        } else {
            let index = this._store.index(indexName);
            if (index === void 0) {
                return null;
            }
            return new IndexedDbIndex(index, indexSchema.keyPath, this._fakeComplicatedKeys);
        }
    }

    openPrimaryKey(): NoSqlProvider.DbIndex {
        return new IndexedDbIndex(this._store, this._schema.primaryKeyPath, this._fakeComplicatedKeys);
    }

    clearAllData(): SyncTasks.Promise<void> {
        let storesToClear = [this._store];
        if (this._indexStores) {
            storesToClear = storesToClear.concat(this._indexStores);
        }

        let promises = _.map(storesToClear, store => IndexedDbProvider.WrapRequest(store.clear()));

        return SyncTasks.all(promises).then(rets => void 0);
    }
}

// DbIndex implementation for the IndexedDB DbProvider.  Fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE and some helpers to make the caller not have to walk the awkward cursor
// result APIs to get their result list.  Also added ability to use an "index" for opening the primary key on a store.
class IndexedDbIndex implements NoSqlProvider.DbIndex {
    private _store: IDBIndex | IDBObjectStore;
    private _keyPath: string | string[];
    private _fakeComplicatedKeys: boolean;
    private _fakedOriginalStore: IDBObjectStore;

    constructor(store: IDBIndex | IDBObjectStore, keyPath: string | string[], fakeComplicatedKeys: boolean,
        fakedOriginalStore?: IDBObjectStore) {
        this._store = store;
        this._keyPath = keyPath;
        this._fakeComplicatedKeys = fakeComplicatedKeys;
        this._fakedOriginalStore = fakedOriginalStore;
    }

    private _resolveCursorResult<T>(req: IDBRequest, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        if (this._fakeComplicatedKeys && this._fakedOriginalStore) {
            // Get based on the keys from the index store, which have refkeys that point back to the original store
            return IndexedDbIndex.getFromCursorRequest<{ key: string, refkey: any }>(req, limit, offset).then(rets => {
                // Now get the original items using the refkeys from the index store, which are PKs on the main store
                var getters = _.map(rets, ret => IndexedDbProvider.WrapRequest<T>(this._fakedOriginalStore.get(ret.refkey)));
                return SyncTasks.all(getters);
            });
        } else {
            return IndexedDbIndex.getFromCursorRequest<T>(req, limit, offset);
        }
    }

    getAll<T>(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        var req = this._store.openCursor(null, reverse ? 'prev' : 'next');
        return this._resolveCursorResult<T>(req, limit, offset);
    }

    getOnly<T>(key: any | any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._keyPath)) {
            key = NoSqlProviderUtils.serializeKeyToString(key, this._keyPath);
        }

        var req = this._store.openCursor(IDBKeyRange.only(key), reverse ? 'prev' : 'next');

        return this._resolveCursorResult<T>(req, limit, offset);
    }

    getRange<T>(keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._keyPath)) {
            // IE has to switch to hacky pre-joined-compound-keys
            keyLowRange = NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath);
            keyHighRange = NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath);
        }

        var req = this._store.openCursor(IDBKeyRange.bound(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive),
            reverse ? 'prev' : 'next');
        return this._resolveCursorResult<T>(req, limit, offset);
    }

    static getFromCursorRequest<T>(req: IDBRequest, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        var outList: any[] = [];
        return this.iterateOverCursorRequest(req, cursor => {
            outList.push(cursor.value);
        }, limit, offset).then(() => {
            return outList;
        });
    }

    static iterateOverCursorRequest(req: IDBRequest, func: (IDBCursor) => void, limit?: number, offset?: number): SyncTasks.Promise<void> {
        const deferred = SyncTasks.Defer<void>();

        var count = 0;
        req.onsuccess = (event) => {
            var cursor: IDBCursor = (<IDBRequest>event.target).result;
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
