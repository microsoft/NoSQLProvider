"use strict";
/**
 * IndexedDbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for IndexedDB, a web browser storage module.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const lodash_1 = require("lodash");
const FullTextSearchHelpers_1 = require("./FullTextSearchHelpers");
const NoSqlProvider_1 = require("./NoSqlProvider");
const NoSqlProviderUtils_1 = require("./NoSqlProviderUtils");
const TransactionLockHelper_1 = require("./TransactionLockHelper");
const IndexPrefix = 'nsp_i_';
// The DbProvider implementation for IndexedDB.  This one is fairly straightforward since the library's access patterns pretty
// closely mirror IndexedDB's.  We mostly do a lot of wrapping of the APIs into JQuery promises and have some fancy footwork to
// do semi-automatic schema upgrades.
class IndexedDbProvider extends NoSqlProvider_1.DbProvider {
    // By default, it uses the in-browser indexed db factory, but you can pass in an explicit factory.  Currently only used for unit tests.
    constructor(explicitDbFactory, explicitDbFactorySupportsCompoundKeys) {
        super();
        if (explicitDbFactory) {
            this._dbFactory = explicitDbFactory;
            this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
        }
        else {
            const win = this.getWindow();
            this._dbFactory = win._indexedDB || win.indexedDB || win.mozIndexedDB || win.webkitIndexedDB || win.msIndexedDB;
            if (typeof explicitDbFactorySupportsCompoundKeys !== 'undefined') {
                this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
            }
            else {
                // IE/Edge's IndexedDB implementation doesn't support compound keys, so we have to fake it by implementing them similar to
                // how the WebSqlProvider does, by concatenating the values into another field which then gets its own index.
                this._fakeComplicatedKeys = NoSqlProviderUtils_1.isIE();
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
        }
        else if (self && self.document === undefined) {
            return self;
        }
        throw new Error('Undefined context');
    }
    static WrapRequest(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = ( /*ev*/) => {
                resolve(req.result);
            };
            req.onerror = (ev) => {
                reject(ev);
            };
        });
    }
    open(dbName, schema, wipeIfExists, verbose) {
        // Note: DbProvider returns null instead of a promise that needs waiting for.
        super.open(dbName, schema, wipeIfExists, verbose);
        if (!this._dbFactory) {
            // Couldn't even find a supported indexeddb object on the browser...
            return Promise.reject('No support for IndexedDB in this browser');
        }
        if (wipeIfExists) {
            try {
                this._dbFactory.deleteDatabase(dbName);
            }
            catch (e) {
                // Don't care
            }
        }
        this._lockHelper = new TransactionLockHelper_1.TransactionLockHelper(schema, true);
        const dbOpen = this._dbFactory.open(dbName, schema.version);
        let migrationPutters = [];
        dbOpen.onupgradeneeded = (event) => {
            const db = dbOpen.result;
            const target = (event.currentTarget || event.target);
            const trans = target.transaction;
            if (!trans) {
                throw new Error('onupgradeneeded: target is null!');
            }
            if (schema.lastUsableVersion && event.oldVersion < schema.lastUsableVersion) {
                // Clear all stores if it's past the usable version
                console.log('Old version detected (' + event.oldVersion + '), clearing all data');
                lodash_1.each(db.objectStoreNames, name => {
                    db.deleteObjectStore(name);
                });
            }
            // Delete dead stores
            lodash_1.each(db.objectStoreNames, storeName => {
                if (!lodash_1.some(schema.stores, store => store.name === storeName)) {
                    db.deleteObjectStore(storeName);
                }
            });
            // Create all stores
            lodash_1.each(schema.stores, storeSchema => {
                let store;
                const storeExistedBefore = lodash_1.includes(db.objectStoreNames, storeSchema.name);
                if (!storeExistedBefore) { // store doesn't exist yet
                    let primaryKeyPath = storeSchema.primaryKeyPath;
                    if (this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(primaryKeyPath)) {
                        // Going to have to hack the compound primary key index into a column, so here it is.
                        primaryKeyPath = 'nsp_pk';
                    }
                    // Any is to fix a lib.d.ts issue in TS 2.0.3 - it doesn't realize that keypaths can be compound for some reason...
                    store = db.createObjectStore(storeSchema.name, { keyPath: primaryKeyPath });
                }
                else { // store exists, might need to update indexes and migrate the data
                    store = trans.objectStore(storeSchema.name);
                    // Check for any indexes no longer in the schema or have been changed
                    lodash_1.each(store.indexNames, indexName => {
                        const index = store.index(indexName);
                        let nuke = false;
                        const indexSchema = lodash_1.find(storeSchema.indexes, idx => idx.name === indexName);
                        if (!indexSchema || !lodash_1.isObject(indexSchema)) {
                            nuke = true;
                        }
                        else if (typeof index.keyPath !== typeof indexSchema.keyPath) {
                            nuke = true;
                        }
                        else if (typeof index.keyPath === 'string') {
                            if (index.keyPath !== indexSchema.keyPath) {
                                nuke = true;
                            }
                        }
                        else /* Keypath is array */ if (index.keyPath.length !== indexSchema.keyPath.length) {
                            // Keypath length doesn't match, don't bother doing a comparison of each element
                            nuke = true;
                        }
                        else {
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
                lodash_1.each(storeSchema.indexes, indexSchema => {
                    if (!lodash_1.includes(store.indexNames, indexSchema.name)) {
                        const keyPath = indexSchema.keyPath;
                        if (this._fakeComplicatedKeys) {
                            if (indexSchema.multiEntry || indexSchema.fullText) {
                                if (NoSqlProviderUtils_1.isCompoundKeyPath(keyPath)) {
                                    throw new Error('Can\'t use multiEntry and compound keys');
                                }
                                else {
                                    // Create an object store for the index
                                    let indexStore = db.createObjectStore(storeSchema.name + '_' + indexSchema.name, { autoIncrement: true });
                                    indexStore.createIndex('key', 'key');
                                    indexStore.createIndex('refkey', 'refkey');
                                    if (storeExistedBefore && !indexSchema.doNotBackfill) {
                                        needsMigrate = true;
                                    }
                                }
                            }
                            else if (NoSqlProviderUtils_1.isCompoundKeyPath(keyPath)) {
                                // Going to have to hack the compound index into a column, so here it is.
                                store.createIndex(indexSchema.name, IndexPrefix + indexSchema.name, {
                                    unique: indexSchema.unique
                                });
                            }
                            else {
                                store.createIndex(indexSchema.name, keyPath, {
                                    unique: indexSchema.unique
                                });
                            }
                        }
                        else if (indexSchema.fullText) {
                            store.createIndex(indexSchema.name, IndexPrefix + indexSchema.name, {
                                unique: false,
                                multiEntry: true
                            });
                            if (storeExistedBefore && !indexSchema.doNotBackfill) {
                                needsMigrate = true;
                            }
                        }
                        else {
                            store.createIndex(indexSchema.name, keyPath, {
                                unique: indexSchema.unique,
                                multiEntry: indexSchema.multiEntry
                            });
                        }
                    }
                });
                if (needsMigrate) {
                    // Walk every element in the store and re-put it to fill out the new index.
                    const fakeToken = {
                        storeNames: [storeSchema.name],
                        exclusive: false,
                        completionPromise: new Promise((resolve) => resolve())
                    };
                    const iTrans = new IndexedDbTransaction(trans, undefined, fakeToken, schema, this._fakeComplicatedKeys);
                    const tStore = iTrans.getStore(storeSchema.name);
                    const cursorReq = store.openCursor();
                    let thisIndexPutters = [];
                    migrationPutters.push(IndexedDbIndex.iterateOverCursorRequest(cursorReq, cursor => {
                        const err = lodash_1.attempt(() => {
                            const item = removeFullTextMetadataAndReturn(storeSchema, cursor.value);
                            thisIndexPutters.push(tStore.put(item));
                        });
                        if (err) {
                            thisIndexPutters.push(Promise.reject(err));
                        }
                    }).then(() => Promise.all(thisIndexPutters).then(lodash_1.noop)));
                }
            });
        };
        const promise = IndexedDbProvider.WrapRequest(dbOpen);
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
            return Promise.reject(err);
        });
    }
    close() {
        if (!this._db) {
            return Promise.reject('Database already closed');
        }
        this._db.close();
        this._db = undefined;
        return Promise.resolve(void 0);
    }
    _deleteDatabaseInternal() {
        const trans = lodash_1.attempt(() => {
            return this._dbFactory.deleteDatabase(this._dbName);
        });
        if (lodash_1.isError(trans)) {
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
    openTransaction(storeNames, writeNeeded) {
        if (!this._db) {
            return Promise.reject('Can\'t openTransaction, database is closed');
        }
        let intStoreNames = storeNames;
        if (this._fakeComplicatedKeys) {
            // Clone the list becuase we're going to add fake store names to it
            intStoreNames = lodash_1.clone(storeNames);
            // Pull the alternate multientry stores into the transaction as well
            let missingStores = [];
            lodash_1.each(storeNames, storeName => {
                let storeSchema = lodash_1.find(this._schema.stores, s => s.name === storeName);
                if (!storeSchema) {
                    missingStores.push(storeName);
                    return;
                }
                if (storeSchema.indexes) {
                    lodash_1.each(storeSchema.indexes, indexSchema => {
                        if (indexSchema.multiEntry || indexSchema.fullText) {
                            intStoreNames.push(storeSchema.name + '_' + indexSchema.name);
                        }
                    });
                }
            });
            if (missingStores.length > 0) {
                return Promise.reject('Can\'t find store(s): ' + missingStores.join(','));
            }
        }
        return this._lockHelper.openTransaction(storeNames, writeNeeded).then(transToken => {
            const trans = lodash_1.attempt(() => {
                return this._db.transaction(intStoreNames, writeNeeded ? 'readwrite' : 'readonly');
            });
            if (lodash_1.isError(trans)) {
                return Promise.reject(trans);
            }
            return Promise.resolve(new IndexedDbTransaction(trans, this._lockHelper, transToken, this._schema, this._fakeComplicatedKeys));
        });
    }
}
exports.IndexedDbProvider = IndexedDbProvider;
// DbTransaction implementation for the IndexedDB DbProvider.
class IndexedDbTransaction {
    constructor(_trans, lockHelper, _transToken, _schema, _fakeComplicatedKeys) {
        this._trans = _trans;
        this._transToken = _transToken;
        this._schema = _schema;
        this._fakeComplicatedKeys = _fakeComplicatedKeys;
        this._stores = lodash_1.map(this._transToken.storeNames, storeName => this._trans.objectStore(storeName));
        if (lockHelper) {
            // Chromium seems to have a bug in their indexeddb implementation that lets it start a timeout
            // while the app is in the middle of a commit (it does a two-phase commit).  It can then finish
            // the commit, and later fire the timeout, despite the transaction having been written out already.
            // In this case, it appears that we should be completely fine to ignore the spurious timeout.
            //
            // Applicable Chromium source code here:
            // https://chromium.googlesource.com/chromium/src/+/master/content/browser/indexed_db/indexed_db_transaction.cc
            let history = [];
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
    getStore(storeName) {
        const store = lodash_1.find(this._stores, s => s.name === storeName);
        const storeSchema = lodash_1.find(this._schema.stores, s => s.name === storeName);
        if (!store || !storeSchema) {
            throw new Error('Store not found: ' + storeName);
        }
        const indexStores = [];
        if (this._fakeComplicatedKeys && storeSchema.indexes) {
            // Pull the alternate multientry stores in as well
            lodash_1.each(storeSchema.indexes, indexSchema => {
                if (indexSchema.multiEntry || indexSchema.fullText) {
                    indexStores.push(this._trans.objectStore(storeSchema.name + '_' + indexSchema.name));
                }
            });
        }
        return new IndexedDbStore(store, indexStores, storeSchema, this._fakeComplicatedKeys);
    }
    getCompletionPromise() {
        return this._transToken.completionPromise;
    }
    abort() {
        // This will wrap through the onAbort above
        this._trans.abort();
    }
    markCompleted() {
        // noop
    }
}
function removeFullTextMetadataAndReturn(schema, val) {
    if (val) {
        // We have full text index fields as real fields on the result, so nuke them before returning them to the caller.
        lodash_1.each(schema.indexes, index => {
            if (index.fullText) {
                delete val[IndexPrefix + index.name];
            }
        });
    }
    return val;
}
// DbStore implementation for the IndexedDB DbProvider.  Again, fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE.
class IndexedDbStore {
    constructor(_store, _indexStores, _schema, _fakeComplicatedKeys) {
        this._store = _store;
        this._indexStores = _indexStores;
        this._schema = _schema;
        this._fakeComplicatedKeys = _fakeComplicatedKeys;
        // NOP
    }
    get(key) {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(this._schema.primaryKeyPath)) {
            const err = lodash_1.attempt(() => {
                key = NoSqlProviderUtils_1.serializeKeyToString(key, this._schema.primaryKeyPath);
            });
            if (err) {
                return Promise.reject(err);
            }
        }
        return IndexedDbProvider.WrapRequest(this._store.get(key))
            .then(val => removeFullTextMetadataAndReturn(this._schema, val));
    }
    getMultiple(keyOrKeys) {
        const keys = lodash_1.attempt(() => {
            const keys = NoSqlProviderUtils_1.formListOfKeys(keyOrKeys, this._schema.primaryKeyPath);
            if (this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(this._schema.primaryKeyPath)) {
                return lodash_1.map(keys, key => NoSqlProviderUtils_1.serializeKeyToString(key, this._schema.primaryKeyPath));
            }
            return keys;
        });
        if (lodash_1.isError(keys)) {
            return Promise.reject(keys);
        }
        // There isn't a more optimized way to do this with indexeddb, have to get the results one by one
        return Promise.all(lodash_1.map(keys, key => IndexedDbProvider.WrapRequest(this._store.get(key)).then(val => removeFullTextMetadataAndReturn(this._schema, val))))
            .then(lodash_1.compact);
    }
    put(itemOrItems) {
        let items = NoSqlProviderUtils_1.arrayify(itemOrItems);
        let promises = [];
        const err = lodash_1.attempt(() => {
            lodash_1.each(items, item => {
                let errToReport;
                let fakedPk = false;
                if (this._fakeComplicatedKeys) {
                    // Fill out any compound-key indexes
                    if (NoSqlProviderUtils_1.isCompoundKeyPath(this._schema.primaryKeyPath)) {
                        fakedPk = true;
                        item['nsp_pk'] = NoSqlProviderUtils_1.getSerializedKeyForKeypath(item, this._schema.primaryKeyPath);
                    }
                    lodash_1.each(this._schema.indexes, index => {
                        if (index.multiEntry || index.fullText) {
                            let indexStore = lodash_1.find(this._indexStores, store => store.name === this._schema.name + '_' + index.name);
                            let keys;
                            if (index.fullText) {
                                keys = FullTextSearchHelpers_1.getFullTextIndexWordsForItem(index.keyPath, item);
                            }
                            else {
                                // Get each value of the multientry and put it into the index store
                                const valsRaw = NoSqlProviderUtils_1.getValueForSingleKeypath(item, index.keyPath);
                                // It might be an array of multiple entries, so just always go with array-based logic
                                keys = NoSqlProviderUtils_1.arrayify(valsRaw);
                            }
                            let refKey;
                            const err = lodash_1.attempt(() => {
                                // We're using normal indexeddb tables to store the multientry indexes, so we only need to use the key
                                // serialization if the multientry keys ALSO are compound.
                                if (NoSqlProviderUtils_1.isCompoundKeyPath(index.keyPath)) {
                                    keys = lodash_1.map(keys, val => NoSqlProviderUtils_1.serializeKeyToString(val, index.keyPath));
                                }
                                // We need to reference the PK of the actual row we're using here, so calculate the actual PK -- if it's
                                // compound, we're already faking complicated keys, so we know to serialize it to a string.  If not, use the
                                // raw value.
                                refKey = NoSqlProviderUtils_1.getKeyForKeypath(item, this._schema.primaryKeyPath);
                                if (lodash_1.isArray(this._schema.primaryKeyPath)) {
                                    refKey = NoSqlProviderUtils_1.serializeKeyToString(refKey, this._schema.primaryKeyPath);
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
                                let iputters = lodash_1.map(keys, key => {
                                    const indexObj = {
                                        key: key,
                                        refkey: refKey
                                    };
                                    return IndexedDbProvider.WrapRequest(indexStore.put(indexObj));
                                });
                                return Promise.all(iputters);
                            }).then(lodash_1.noop));
                        }
                        else if (NoSqlProviderUtils_1.isCompoundKeyPath(index.keyPath)) {
                            item[IndexPrefix + index.name] = NoSqlProviderUtils_1.getSerializedKeyForKeypath(item, index.keyPath);
                        }
                        return true;
                    });
                }
                else {
                    lodash_1.each(this._schema.indexes, index => {
                        if (index.fullText) {
                            item[IndexPrefix + index.name] =
                                FullTextSearchHelpers_1.getFullTextIndexWordsForItem(index.keyPath, item);
                        }
                    });
                }
                if (!errToReport) {
                    errToReport = lodash_1.attempt(() => {
                        const req = this._store.put(item);
                        if (fakedPk) {
                            // If we faked the PK and mutated the incoming object, we can nuke that on the way out.  IndexedDB clones the
                            // object synchronously for the put call, so it's already been captured with the nsp_pk field intact.
                            delete item['nsp_pk'];
                        }
                        promises.push(IndexedDbProvider.WrapRequest(req));
                    });
                }
                if (errToReport) {
                    promises.push(Promise.reject(errToReport));
                }
            });
        });
        if (err) {
            return Promise.reject(err);
        }
        return Promise.all(promises).then(lodash_1.noop);
    }
    remove(keyOrKeys) {
        const keys = lodash_1.attempt(() => {
            const keys = NoSqlProviderUtils_1.formListOfKeys(keyOrKeys, this._schema.primaryKeyPath);
            if (this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(this._schema.primaryKeyPath)) {
                return lodash_1.map(keys, key => NoSqlProviderUtils_1.serializeKeyToString(key, this._schema.primaryKeyPath));
            }
            return keys;
        });
        if (lodash_1.isError(keys)) {
            return Promise.reject(keys);
        }
        return Promise.all(lodash_1.map(keys, key => {
            if (this._fakeComplicatedKeys && lodash_1.some(this._schema.indexes, index => index.multiEntry || index.fullText)) {
                // If we're faking keys and there's any multientry indexes, we have to do the way more complicated version...
                return IndexedDbProvider.WrapRequest(this._store.get(key)).then(item => {
                    if (item) {
                        // Go through each multiEntry index and nuke the referenced items from the sub-stores
                        let promises = lodash_1.map(lodash_1.filter(this._schema.indexes, index => !!index.multiEntry), index => {
                            let indexStore = lodash_1.find(this._indexStores, store => store.name === this._schema.name + '_' + index.name);
                            const refKey = lodash_1.attempt(() => {
                                // We need to reference the PK of the actual row we're using here, so calculate the actual PK -- if it's
                                // compound, we're already faking complicated keys, so we know to serialize it to a string.  If not, use the
                                // raw value.
                                const tempRefKey = NoSqlProviderUtils_1.getKeyForKeypath(item, this._schema.primaryKeyPath);
                                return lodash_1.isArray(this._schema.primaryKeyPath) ?
                                    NoSqlProviderUtils_1.serializeKeyToString(tempRefKey, this._schema.primaryKeyPath) :
                                    tempRefKey;
                            });
                            if (lodash_1.isError(refKey)) {
                                return Promise.reject(refKey);
                            }
                            // First clear out the old values from the index store for the refkey
                            const cursorReq = indexStore.index('refkey').openCursor(IDBKeyRange.only(refKey));
                            return IndexedDbIndex.iterateOverCursorRequest(cursorReq, cursor => {
                                cursor['delete']();
                            });
                        });
                        // Also remember to nuke the item from the actual store
                        promises.push(IndexedDbProvider.WrapRequest(this._store['delete'](key)));
                        return Promise.all(promises).then(lodash_1.noop);
                    }
                    return undefined;
                });
            }
            return IndexedDbProvider.WrapRequest(this._store['delete'](key));
        })).then(lodash_1.noop);
    }
    removeRange(indexName, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        const index = lodash_1.attempt(() => {
            return indexName ? this.openIndex(indexName) : this.openPrimaryKey();
        });
        if (!index || lodash_1.isError(index)) {
            return Promise.reject('Index "' + indexName + '" not found');
        }
        return index.getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).then(keys => {
            this.remove(keys);
        });
    }
    openIndex(indexName) {
        const indexSchema = lodash_1.find(this._schema.indexes, idx => idx.name === indexName);
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }
        if (this._fakeComplicatedKeys && (indexSchema.multiEntry || indexSchema.fullText)) {
            const store = lodash_1.find(this._indexStores, indexStore => indexStore.name === this._schema.name + '_' + indexSchema.name);
            if (!store) {
                throw new Error('Indexstore not found: ' + this._schema.name + '_' + indexSchema.name);
            }
            return new IndexedDbIndex(store.index('key'), indexSchema, this._schema.primaryKeyPath, this._fakeComplicatedKeys, this._store);
        }
        else {
            const index = this._store.index(indexName);
            if (!index) {
                throw new Error('Index store not found: ' + indexName);
            }
            return new IndexedDbIndex(index, indexSchema, this._schema.primaryKeyPath, this._fakeComplicatedKeys);
        }
    }
    openPrimaryKey() {
        return new IndexedDbIndex(this._store, undefined, this._schema.primaryKeyPath, this._fakeComplicatedKeys);
    }
    clearAllData() {
        let storesToClear = [this._store];
        if (this._indexStores) {
            storesToClear = storesToClear.concat(this._indexStores);
        }
        let promises = lodash_1.map(storesToClear, store => IndexedDbProvider.WrapRequest(store.clear()));
        return Promise.all(promises).then(lodash_1.noop);
    }
}
// DbIndex implementation for the IndexedDB DbProvider.  Fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE and some helpers to make the caller not have to walk the awkward cursor
// result APIs to get their result list.  Also added ability to use an "index" for opening the primary key on a store.
class IndexedDbIndex extends FullTextSearchHelpers_1.DbIndexFTSFromRangeQueries {
    constructor(_store, indexSchema, primaryKeyPath, _fakeComplicatedKeys, _fakedOriginalStore) {
        super(indexSchema, primaryKeyPath);
        this._store = _store;
        this._fakeComplicatedKeys = _fakeComplicatedKeys;
        this._fakedOriginalStore = _fakedOriginalStore;
    }
    _resolveCursorResult(req, limit, offset) {
        if (this._fakeComplicatedKeys && this._fakedOriginalStore) {
            // Get based on the keys from the index store, which have refkeys that point back to the original store
            return IndexedDbIndex.getFromCursorRequest(req, limit, offset).then(rets => {
                // Now get the original items using the refkeys from the index store, which are PKs on the main store
                const getters = lodash_1.map(rets, ret => IndexedDbProvider.WrapRequest(this._fakedOriginalStore.get(ret.refkey)));
                return Promise.all(getters);
            });
        }
        else {
            return IndexedDbIndex.getFromCursorRequest(req, limit, offset);
        }
    }
    getAll(reverseOrSortOrder, limit, offset) {
        const reverse = reverseOrSortOrder === true || reverseOrSortOrder === NoSqlProvider_1.QuerySortOrder.Reverse;
        if (!reverse && this._store.getAll && !offset && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest(this._store.getAll(undefined, limit));
        }
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        const req = this._store.openCursor(null, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    }
    getOnly(key, reverseOrSortOrder, limit, offset) {
        const keyRange = lodash_1.attempt(() => {
            return this._getKeyRangeForOnly(key);
        });
        if (lodash_1.isError(keyRange)) {
            return Promise.reject(keyRange);
        }
        const reverse = reverseOrSortOrder === true || reverseOrSortOrder === NoSqlProvider_1.QuerySortOrder.Reverse;
        if (!reverse && this._store.getAll && !offset && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest(this._store.getAll(keyRange, limit));
        }
        const req = this._store.openCursor(keyRange, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    }
    // Warning: This function can throw, make sure to trap.
    _getKeyRangeForOnly(key) {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(this._keyPath)) {
            return IDBKeyRange.only(NoSqlProviderUtils_1.serializeKeyToString(key, this._keyPath));
        }
        return IDBKeyRange.only(key);
    }
    getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset) {
        const keyRange = lodash_1.attempt(() => {
            return this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keyRange)) {
            return Promise.reject(keyRange);
        }
        const reverse = reverseOrSortOrder === true || reverseOrSortOrder === NoSqlProvider_1.QuerySortOrder.Reverse;
        if (!reverse && this._store.getAll && !offset && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest(this._store.getAll(keyRange, limit));
        }
        const req = this._store.openCursor(keyRange, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    }
    // Warning: This function can throw, make sure to trap.
    _getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(this._keyPath)) {
            // IE has to switch to hacky pre-joined-compound-keys
            return IDBKeyRange.bound(NoSqlProviderUtils_1.serializeKeyToString(keyLowRange, this._keyPath), NoSqlProviderUtils_1.serializeKeyToString(keyHighRange, this._keyPath), lowRangeExclusive, highRangeExclusive);
        }
        return IDBKeyRange.bound(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
    }
    countAll() {
        const req = this._store.count();
        return this._countRequest(req);
    }
    countOnly(key) {
        const keyRange = lodash_1.attempt(() => {
            return this._getKeyRangeForOnly(key);
        });
        if (lodash_1.isError(keyRange)) {
            return Promise.reject(keyRange);
        }
        const req = this._store.count(keyRange);
        return this._countRequest(req);
    }
    countRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        let keyRange = lodash_1.attempt(() => {
            return this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keyRange)) {
            return Promise.reject(keyRange);
        }
        const req = this._store.count(keyRange);
        return this._countRequest(req);
    }
    getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        const keyRange = lodash_1.attempt(() => {
            return this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keyRange)) {
            return Promise.reject(keyRange);
        }
        if (this._store.getAllKeys && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest(this._store.getAllKeys(keyRange));
        }
        let keys = [];
        let req = this._store.openCursor(keyRange, 'next');
        return IndexedDbIndex.iterateOverCursorRequest(req, cursor => {
            keys.push(cursor.key);
        }).then(() => {
            return keys;
        });
    }
    static getFromCursorRequest(req, limit, offset) {
        let outList = [];
        return this.iterateOverCursorRequest(req, cursor => {
            // Typings on cursor are wrong...
            outList.push(cursor.value);
        }, limit, offset).then(() => {
            return outList;
        });
    }
    _countRequest(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = (event) => {
                resolve(event.target.result);
            };
            req.onerror = (ev) => {
                reject(ev);
            };
        });
    }
    static iterateOverCursorRequest(req, func, limit, offset) {
        return new Promise((resolve, reject) => {
            let count = 0;
            req.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (offset) {
                        cursor.advance(offset);
                        offset = 0;
                    }
                    else {
                        func(cursor);
                        count++;
                        if (limit && (count === limit)) {
                            resolve(void 0);
                            return;
                        }
                        cursor['continue']();
                    }
                }
                else {
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
//# sourceMappingURL=IndexedDbProvider.js.map