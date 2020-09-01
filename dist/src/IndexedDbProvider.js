"use strict";
/**
 * IndexedDbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for IndexedDB, a web browser storage module.
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
var lodash_1 = require("lodash");
var FullTextSearchHelpers_1 = require("./FullTextSearchHelpers");
var NoSqlProvider_1 = require("./NoSqlProvider");
var NoSqlProviderUtils_1 = require("./NoSqlProviderUtils");
var TransactionLockHelper_1 = require("./TransactionLockHelper");
var IndexPrefix = 'nsp_i_';
// The DbProvider implementation for IndexedDB.  This one is fairly straightforward since the library's access patterns pretty
// closely mirror IndexedDB's.  We mostly do a lot of wrapping of the APIs into JQuery promises and have some fancy footwork to
// do semi-automatic schema upgrades.
var IndexedDbProvider = /** @class */ (function (_super) {
    __extends(IndexedDbProvider, _super);
    // By default, it uses the in-browser indexed db factory, but you can pass in an explicit factory.  Currently only used for unit tests.
    function IndexedDbProvider(explicitDbFactory, explicitDbFactorySupportsCompoundKeys) {
        var _this = _super.call(this) || this;
        if (explicitDbFactory) {
            _this._dbFactory = explicitDbFactory;
            _this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
        }
        else {
            var win = _this.getWindow();
            _this._dbFactory = win._indexedDB || win.indexedDB || win.mozIndexedDB || win.webkitIndexedDB || win.msIndexedDB;
            if (typeof explicitDbFactorySupportsCompoundKeys !== 'undefined') {
                _this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
            }
            else {
                // IE/Edge's IndexedDB implementation doesn't support compound keys, so we have to fake it by implementing them similar to
                // how the WebSqlProvider does, by concatenating the values into another field which then gets its own index.
                _this._fakeComplicatedKeys = NoSqlProviderUtils_1.isIE();
            }
        }
        return _this;
    }
    /**
     * Gets global window object - whether operating in worker or UI thread context.
     * Adapted from: https://stackoverflow.com/questions/7931182/reliably-detect-if-the-script-is-executing-in-a-web-worker
     */
    IndexedDbProvider.prototype.getWindow = function () {
        if (typeof window === 'object' && window.document) {
            return window;
        }
        else if (self && self.document === undefined) {
            return self;
        }
        throw new Error('Undefined context');
    };
    IndexedDbProvider.WrapRequest = function (req) {
        return new Promise(function (resolve, reject) {
            req.onsuccess = function ( /*ev*/) {
                resolve(req.result);
            };
            req.onerror = function (ev) {
                reject(ev);
            };
        });
    };
    IndexedDbProvider.prototype.open = function (dbName, schema, wipeIfExists, verbose) {
        var _this = this;
        // Note: DbProvider returns null instead of a promise that needs waiting for.
        _super.prototype.open.call(this, dbName, schema, wipeIfExists, verbose);
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
        var dbOpen = this._dbFactory.open(dbName, schema.version);
        var migrationPutters = [];
        dbOpen.onupgradeneeded = function (event) {
            var db = dbOpen.result;
            var target = (event.currentTarget || event.target);
            var trans = target.transaction;
            if (!trans) {
                throw new Error('onupgradeneeded: target is null!');
            }
            if (schema.lastUsableVersion && event.oldVersion < schema.lastUsableVersion) {
                // Clear all stores if it's past the usable version
                console.log('Old version detected (' + event.oldVersion + '), clearing all data');
                lodash_1.each(db.objectStoreNames, function (name) {
                    db.deleteObjectStore(name);
                });
            }
            // Delete dead stores
            lodash_1.each(db.objectStoreNames, function (storeName) {
                if (!lodash_1.some(schema.stores, function (store) { return store.name === storeName; })) {
                    db.deleteObjectStore(storeName);
                }
            });
            // Create all stores
            lodash_1.each(schema.stores, function (storeSchema) {
                var store;
                var storeExistedBefore = lodash_1.includes(db.objectStoreNames, storeSchema.name);
                if (!storeExistedBefore) { // store doesn't exist yet
                    var primaryKeyPath = storeSchema.primaryKeyPath;
                    if (_this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(primaryKeyPath)) {
                        // Going to have to hack the compound primary key index into a column, so here it is.
                        primaryKeyPath = 'nsp_pk';
                    }
                    // Any is to fix a lib.d.ts issue in TS 2.0.3 - it doesn't realize that keypaths can be compound for some reason...
                    store = db.createObjectStore(storeSchema.name, { keyPath: primaryKeyPath });
                }
                else { // store exists, might need to update indexes and migrate the data
                    store = trans.objectStore(storeSchema.name);
                    // Check for any indexes no longer in the schema or have been changed
                    lodash_1.each(store.indexNames, function (indexName) {
                        var index = store.index(indexName);
                        var nuke = false;
                        var indexSchema = lodash_1.find(storeSchema.indexes, function (idx) { return idx.name === indexName; });
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
                // IndexedDB deals well with adding new indexes on the fly, so we don't need to force migrate, 
                // unless adding multiEntry or fullText index
                var needsMigrate = false;
                // Check any indexes in the schema that need to be created
                lodash_1.each(storeSchema.indexes, function (indexSchema) {
                    if (!lodash_1.includes(store.indexNames, indexSchema.name)) {
                        var keyPath = indexSchema.keyPath;
                        if (_this._fakeComplicatedKeys) {
                            if (indexSchema.multiEntry || indexSchema.fullText) {
                                if (NoSqlProviderUtils_1.isCompoundKeyPath(keyPath)) {
                                    throw new Error('Can\'t use multiEntry and compound keys');
                                }
                                else {
                                    // Create an object store for the index
                                    var indexStore = db.createObjectStore(storeSchema.name + '_' + indexSchema.name, { autoIncrement: true });
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
                    var fakeToken = {
                        storeNames: [storeSchema.name],
                        exclusive: false,
                        completionPromise: new Promise(function (resolve) { return resolve(); })
                    };
                    var iTrans = new IndexedDbTransaction(trans, undefined, fakeToken, schema, _this._fakeComplicatedKeys);
                    var tStore_1 = iTrans.getStore(storeSchema.name);
                    var cursorReq = store.openCursor();
                    var thisIndexPutters_1 = [];
                    migrationPutters.push(IndexedDbIndex.iterateOverCursorRequest(cursorReq, function (cursor) {
                        var err = lodash_1.attempt(function () {
                            var item = removeFullTextMetadataAndReturn(storeSchema, cursor.value);
                            thisIndexPutters_1.push(tStore_1.put(item));
                        });
                        if (err) {
                            thisIndexPutters_1.push(Promise.reject(err));
                        }
                    }).then(function () { return Promise.all(thisIndexPutters_1).then(lodash_1.noop); }));
                }
            });
        };
        var promise = IndexedDbProvider.WrapRequest(dbOpen);
        return promise.then(function (db) {
            return Promise.all(migrationPutters).then(function () {
                _this._db = db;
            });
        }, function (err) {
            if (err && err.type === 'error' && err.target && err.target.error && err.target.error.name === 'VersionError') {
                if (!wipeIfExists) {
                    console.log('Database version too new, Wiping: ' + (err.target.error.message || err.target.error.name));
                    return _this.open(dbName, schema, true, verbose);
                }
            }
            return Promise.reject(err);
        });
    };
    IndexedDbProvider.prototype.close = function () {
        if (!this._db) {
            return Promise.reject('Database already closed');
        }
        this._db.close();
        this._db = undefined;
        return Promise.resolve(void 0);
    };
    IndexedDbProvider.prototype._deleteDatabaseInternal = function () {
        var _this = this;
        var trans = lodash_1.attempt(function () {
            return _this._dbFactory.deleteDatabase(_this._dbName);
        });
        if (lodash_1.isError(trans)) {
            return Promise.reject(trans);
        }
        return new Promise(function (resolve, reject) {
            trans.onsuccess = function () {
                resolve(void 0);
            };
            trans.onerror = function (ev) {
                reject(ev);
            };
        });
    };
    IndexedDbProvider.prototype.openTransaction = function (storeNames, writeNeeded) {
        var _this = this;
        if (!this._db) {
            return Promise.reject('Can\'t openTransaction, database is closed');
        }
        var intStoreNames = storeNames;
        if (this._fakeComplicatedKeys) {
            // Clone the list becuase we're going to add fake store names to it
            intStoreNames = lodash_1.clone(storeNames);
            // Pull the alternate multientry stores into the transaction as well
            var missingStores_1 = [];
            lodash_1.each(storeNames, function (storeName) {
                var storeSchema = lodash_1.find(_this._schema.stores, function (s) { return s.name === storeName; });
                if (!storeSchema) {
                    missingStores_1.push(storeName);
                    return;
                }
                if (storeSchema.indexes) {
                    lodash_1.each(storeSchema.indexes, function (indexSchema) {
                        if (indexSchema.multiEntry || indexSchema.fullText) {
                            intStoreNames.push(storeSchema.name + '_' + indexSchema.name);
                        }
                    });
                }
            });
            if (missingStores_1.length > 0) {
                return Promise.reject('Can\'t find store(s): ' + missingStores_1.join(','));
            }
        }
        return this._lockHelper.openTransaction(storeNames, writeNeeded).then(function (transToken) {
            var trans = lodash_1.attempt(function () {
                return _this._db.transaction(intStoreNames, writeNeeded ? 'readwrite' : 'readonly');
            });
            if (lodash_1.isError(trans)) {
                return Promise.reject(trans);
            }
            return Promise.resolve(new IndexedDbTransaction(trans, _this._lockHelper, transToken, _this._schema, _this._fakeComplicatedKeys));
        });
    };
    return IndexedDbProvider;
}(NoSqlProvider_1.DbProvider));
exports.IndexedDbProvider = IndexedDbProvider;
// DbTransaction implementation for the IndexedDB DbProvider.
var IndexedDbTransaction = /** @class */ (function () {
    function IndexedDbTransaction(_trans, lockHelper, _transToken, _schema, _fakeComplicatedKeys) {
        var _this = this;
        this._trans = _trans;
        this._transToken = _transToken;
        this._schema = _schema;
        this._fakeComplicatedKeys = _fakeComplicatedKeys;
        this._stores = lodash_1.map(this._transToken.storeNames, function (storeName) { return _this._trans.objectStore(storeName); });
        if (lockHelper) {
            // Chromium seems to have a bug in their indexeddb implementation that lets it start a timeout
            // while the app is in the middle of a commit (it does a two-phase commit).  It can then finish
            // the commit, and later fire the timeout, despite the transaction having been written out already.
            // In this case, it appears that we should be completely fine to ignore the spurious timeout.
            //
            // Applicable Chromium source code here:
            // https://chromium.googlesource.com/chromium/src/+/master/content/browser/indexed_db/indexed_db_transaction.cc
            var history_1 = [];
            this._trans.oncomplete = function () {
                history_1.push('complete');
                lockHelper.transactionComplete(_this._transToken);
            };
            this._trans.onerror = function () {
                history_1.push('error-' + (_this._trans.error ? _this._trans.error.message : ''));
                if (history_1.length > 1) {
                    console.warn('IndexedDbTransaction Errored after Resolution, Swallowing. Error: ' +
                        (_this._trans.error ? _this._trans.error.message : undefined) + ', History: ' + history_1.join(','));
                    return;
                }
                lockHelper.transactionFailed(_this._transToken, 'IndexedDbTransaction OnError: ' +
                    (_this._trans.error ? _this._trans.error.message : undefined) + ', History: ' + history_1.join(','));
            };
            this._trans.onabort = function () {
                history_1.push('abort-' + (_this._trans.error ? _this._trans.error.message : ''));
                if (history_1.length > 1) {
                    console.warn('IndexedDbTransaction Aborted after Resolution, Swallowing. Error: ' +
                        (_this._trans.error ? _this._trans.error.message : undefined) + ', History: ' + history_1.join(','));
                    return;
                }
                lockHelper.transactionFailed(_this._transToken, 'IndexedDbTransaction Aborted, Error: ' +
                    (_this._trans.error ? _this._trans.error.message : undefined) + ', History: ' + history_1.join(','));
            };
        }
    }
    IndexedDbTransaction.prototype.getStore = function (storeName) {
        var _this = this;
        var store = lodash_1.find(this._stores, function (s) { return s.name === storeName; });
        var storeSchema = lodash_1.find(this._schema.stores, function (s) { return s.name === storeName; });
        if (!store || !storeSchema) {
            throw new Error('Store not found: ' + storeName);
        }
        var indexStores = [];
        if (this._fakeComplicatedKeys && storeSchema.indexes) {
            // Pull the alternate multientry stores in as well
            lodash_1.each(storeSchema.indexes, function (indexSchema) {
                if (indexSchema.multiEntry || indexSchema.fullText) {
                    indexStores.push(_this._trans.objectStore(storeSchema.name + '_' + indexSchema.name));
                }
            });
        }
        return new IndexedDbStore(store, indexStores, storeSchema, this._fakeComplicatedKeys);
    };
    IndexedDbTransaction.prototype.getCompletionPromise = function () {
        return this._transToken.completionPromise;
    };
    IndexedDbTransaction.prototype.abort = function () {
        // This will wrap through the onAbort above
        this._trans.abort();
    };
    IndexedDbTransaction.prototype.markCompleted = function () {
        // noop
    };
    return IndexedDbTransaction;
}());
function removeFullTextMetadataAndReturn(schema, val) {
    if (val) {
        // We have full text index fields as real fields on the result, so nuke them before returning them to the caller.
        lodash_1.each(schema.indexes, function (index) {
            if (index.fullText) {
                delete val[IndexPrefix + index.name];
            }
        });
    }
    return val;
}
// DbStore implementation for the IndexedDB DbProvider.  Again, fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE.
var IndexedDbStore = /** @class */ (function () {
    function IndexedDbStore(_store, _indexStores, _schema, _fakeComplicatedKeys) {
        this._store = _store;
        this._indexStores = _indexStores;
        this._schema = _schema;
        this._fakeComplicatedKeys = _fakeComplicatedKeys;
        // NOP
    }
    IndexedDbStore.prototype.get = function (key) {
        var _this = this;
        if (this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(this._schema.primaryKeyPath)) {
            var err = lodash_1.attempt(function () {
                key = NoSqlProviderUtils_1.serializeKeyToString(key, _this._schema.primaryKeyPath);
            });
            if (err) {
                return Promise.reject(err);
            }
        }
        return IndexedDbProvider.WrapRequest(this._store.get(key))
            .then(function (val) { return removeFullTextMetadataAndReturn(_this._schema, val); });
    };
    IndexedDbStore.prototype.getMultiple = function (keyOrKeys) {
        var _this = this;
        var keys = lodash_1.attempt(function () {
            var keys = NoSqlProviderUtils_1.formListOfKeys(keyOrKeys, _this._schema.primaryKeyPath);
            if (_this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(_this._schema.primaryKeyPath)) {
                return lodash_1.map(keys, function (key) { return NoSqlProviderUtils_1.serializeKeyToString(key, _this._schema.primaryKeyPath); });
            }
            return keys;
        });
        if (lodash_1.isError(keys)) {
            return Promise.reject(keys);
        }
        // There isn't a more optimized way to do this with indexeddb, have to get the results one by one
        return Promise.all(lodash_1.map(keys, function (key) {
            return IndexedDbProvider.WrapRequest(_this._store.get(key)).then(function (val) { return removeFullTextMetadataAndReturn(_this._schema, val); });
        }))
            .then(lodash_1.compact);
    };
    IndexedDbStore.prototype.put = function (itemOrItems) {
        var _this = this;
        var items = NoSqlProviderUtils_1.arrayify(itemOrItems);
        var promises = [];
        var err = lodash_1.attempt(function () {
            lodash_1.each(items, function (item) {
                var errToReport;
                var fakedPk = false;
                if (_this._fakeComplicatedKeys) {
                    // Fill out any compound-key indexes
                    if (NoSqlProviderUtils_1.isCompoundKeyPath(_this._schema.primaryKeyPath)) {
                        fakedPk = true;
                        item['nsp_pk'] = NoSqlProviderUtils_1.getSerializedKeyForKeypath(item, _this._schema.primaryKeyPath);
                    }
                    lodash_1.each(_this._schema.indexes, function (index) {
                        if (index.multiEntry || index.fullText) {
                            var indexStore_1 = lodash_1.find(_this._indexStores, function (store) { return store.name === _this._schema.name + '_' + index.name; });
                            var keys_1;
                            if (index.fullText) {
                                keys_1 = FullTextSearchHelpers_1.getFullTextIndexWordsForItem(index.keyPath, item);
                            }
                            else {
                                // Get each value of the multientry and put it into the index store
                                var valsRaw = NoSqlProviderUtils_1.getValueForSingleKeypath(item, index.keyPath);
                                // It might be an array of multiple entries, so just always go with array-based logic
                                keys_1 = NoSqlProviderUtils_1.arrayify(valsRaw);
                            }
                            var refKey_1;
                            var err_1 = lodash_1.attempt(function () {
                                // We're using normal indexeddb tables to store the multientry indexes, so we only need to use the key
                                // serialization if the multientry keys ALSO are compound.
                                if (NoSqlProviderUtils_1.isCompoundKeyPath(index.keyPath)) {
                                    keys_1 = lodash_1.map(keys_1, function (val) { return NoSqlProviderUtils_1.serializeKeyToString(val, index.keyPath); });
                                }
                                // We need to reference the PK of the actual row we're using here, so calculate the actual PK -- if it's
                                // compound, we're already faking complicated keys, so we know to serialize it to a string.  If not, use the
                                // raw value.
                                refKey_1 = NoSqlProviderUtils_1.getKeyForKeypath(item, _this._schema.primaryKeyPath);
                                if (lodash_1.isArray(_this._schema.primaryKeyPath)) {
                                    refKey_1 = NoSqlProviderUtils_1.serializeKeyToString(refKey_1, _this._schema.primaryKeyPath);
                                }
                            });
                            if (err_1) {
                                errToReport = err_1;
                                return false;
                            }
                            // First clear out the old values from the index store for the refkey
                            var cursorReq = indexStore_1.index('refkey').openCursor(IDBKeyRange.only(refKey_1));
                            promises.push(IndexedDbIndex.iterateOverCursorRequest(cursorReq, function (cursor) {
                                cursor['delete']();
                            })
                                .then(function () {
                                // After nuking the existing entries, add the new ones
                                var iputters = lodash_1.map(keys_1, function (key) {
                                    var indexObj = {
                                        key: key,
                                        refkey: refKey_1
                                    };
                                    return IndexedDbProvider.WrapRequest(indexStore_1.put(indexObj));
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
                    lodash_1.each(_this._schema.indexes, function (index) {
                        if (index.fullText) {
                            item[IndexPrefix + index.name] =
                                FullTextSearchHelpers_1.getFullTextIndexWordsForItem(index.keyPath, item);
                        }
                    });
                }
                if (!errToReport) {
                    errToReport = lodash_1.attempt(function () {
                        var req = _this._store.put(item);
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
    };
    IndexedDbStore.prototype.remove = function (keyOrKeys) {
        var _this = this;
        var keys = lodash_1.attempt(function () {
            var keys = NoSqlProviderUtils_1.formListOfKeys(keyOrKeys, _this._schema.primaryKeyPath);
            if (_this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(_this._schema.primaryKeyPath)) {
                return lodash_1.map(keys, function (key) { return NoSqlProviderUtils_1.serializeKeyToString(key, _this._schema.primaryKeyPath); });
            }
            return keys;
        });
        if (lodash_1.isError(keys)) {
            return Promise.reject(keys);
        }
        return Promise.all(lodash_1.map(keys, function (key) {
            if (_this._fakeComplicatedKeys && lodash_1.some(_this._schema.indexes, function (index) { return index.multiEntry || index.fullText; })) {
                // If we're faking keys and there's any multientry indexes, we have to do the way more complicated version...
                return IndexedDbProvider.WrapRequest(_this._store.get(key)).then(function (item) {
                    if (item) {
                        // Go through each multiEntry index and nuke the referenced items from the sub-stores
                        var promises = lodash_1.map(lodash_1.filter(_this._schema.indexes, function (index) { return !!index.multiEntry; }), function (index) {
                            var indexStore = lodash_1.find(_this._indexStores, function (store) { return store.name === _this._schema.name + '_' + index.name; });
                            var refKey = lodash_1.attempt(function () {
                                // We need to reference the PK of the actual row we're using here, so calculate the actual PK -- if it's
                                // compound, we're already faking complicated keys, so we know to serialize it to a string.  If not, use the
                                // raw value.
                                var tempRefKey = NoSqlProviderUtils_1.getKeyForKeypath(item, _this._schema.primaryKeyPath);
                                return lodash_1.isArray(_this._schema.primaryKeyPath) ?
                                    NoSqlProviderUtils_1.serializeKeyToString(tempRefKey, _this._schema.primaryKeyPath) :
                                    tempRefKey;
                            });
                            if (lodash_1.isError(refKey)) {
                                return Promise.reject(refKey);
                            }
                            // First clear out the old values from the index store for the refkey
                            var cursorReq = indexStore.index('refkey').openCursor(IDBKeyRange.only(refKey));
                            return IndexedDbIndex.iterateOverCursorRequest(cursorReq, function (cursor) {
                                cursor['delete']();
                            });
                        });
                        // Also remember to nuke the item from the actual store
                        promises.push(IndexedDbProvider.WrapRequest(_this._store['delete'](key)));
                        return Promise.all(promises).then(lodash_1.noop);
                    }
                    return undefined;
                });
            }
            return IndexedDbProvider.WrapRequest(_this._store['delete'](key));
        })).then(lodash_1.noop);
    };
    IndexedDbStore.prototype.removeRange = function (indexName, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var _this = this;
        var index = lodash_1.attempt(function () {
            return indexName ? _this.openIndex(indexName) : _this.openPrimaryKey();
        });
        if (!index || lodash_1.isError(index)) {
            return Promise.reject('Index "' + indexName + '" not found');
        }
        return index.getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).then(function (keys) {
            _this.remove(keys);
        });
    };
    IndexedDbStore.prototype.openIndex = function (indexName) {
        var _this = this;
        var indexSchema = lodash_1.find(this._schema.indexes, function (idx) { return idx.name === indexName; });
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }
        if (this._fakeComplicatedKeys && (indexSchema.multiEntry || indexSchema.fullText)) {
            var store = lodash_1.find(this._indexStores, function (indexStore) { return indexStore.name === _this._schema.name + '_' + indexSchema.name; });
            if (!store) {
                throw new Error('Indexstore not found: ' + this._schema.name + '_' + indexSchema.name);
            }
            return new IndexedDbIndex(store.index('key'), indexSchema, this._schema.primaryKeyPath, this._fakeComplicatedKeys, this._store);
        }
        else {
            var index = this._store.index(indexName);
            if (!index) {
                throw new Error('Index store not found: ' + indexName);
            }
            return new IndexedDbIndex(index, indexSchema, this._schema.primaryKeyPath, this._fakeComplicatedKeys);
        }
    };
    IndexedDbStore.prototype.openPrimaryKey = function () {
        return new IndexedDbIndex(this._store, undefined, this._schema.primaryKeyPath, this._fakeComplicatedKeys);
    };
    IndexedDbStore.prototype.clearAllData = function () {
        var storesToClear = [this._store];
        if (this._indexStores) {
            storesToClear = storesToClear.concat(this._indexStores);
        }
        var promises = lodash_1.map(storesToClear, function (store) { return IndexedDbProvider.WrapRequest(store.clear()); });
        return Promise.all(promises).then(lodash_1.noop);
    };
    return IndexedDbStore;
}());
// DbIndex implementation for the IndexedDB DbProvider.  Fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE and some helpers to make the caller not have to walk the awkward cursor
// result APIs to get their result list.  Also added ability to use an "index" for opening the primary key on a store.
var IndexedDbIndex = /** @class */ (function (_super) {
    __extends(IndexedDbIndex, _super);
    function IndexedDbIndex(_store, indexSchema, primaryKeyPath, _fakeComplicatedKeys, _fakedOriginalStore) {
        var _this = _super.call(this, indexSchema, primaryKeyPath) || this;
        _this._store = _store;
        _this._fakeComplicatedKeys = _fakeComplicatedKeys;
        _this._fakedOriginalStore = _fakedOriginalStore;
        return _this;
    }
    IndexedDbIndex.prototype._resolveCursorResult = function (req, limit, offset) {
        var _this = this;
        if (this._fakeComplicatedKeys && this._fakedOriginalStore) {
            // Get based on the keys from the index store, which have refkeys that point back to the original store
            return IndexedDbIndex.getFromCursorRequest(req, limit, offset).then(function (rets) {
                // Now get the original items using the refkeys from the index store, which are PKs on the main store
                var getters = lodash_1.map(rets, function (ret) { return IndexedDbProvider.WrapRequest(_this._fakedOriginalStore.get(ret.refkey)); });
                return Promise.all(getters);
            });
        }
        else {
            return IndexedDbIndex.getFromCursorRequest(req, limit, offset);
        }
    };
    IndexedDbIndex.prototype.getAll = function (reverseOrSortOrder, limit, offset) {
        var reverse = reverseOrSortOrder === true || reverseOrSortOrder === NoSqlProvider_1.QuerySortOrder.Reverse;
        if (!reverse && this._store.getAll && !offset && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest(this._store.getAll(undefined, limit));
        }
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        // ************************* Don't change this null to undefined, IE chokes on it... *****************************
        var req = this._store.openCursor(null, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    };
    IndexedDbIndex.prototype.getOnly = function (key, reverseOrSortOrder, limit, offset) {
        var _this = this;
        var keyRange = lodash_1.attempt(function () {
            return _this._getKeyRangeForOnly(key);
        });
        if (lodash_1.isError(keyRange)) {
            return Promise.reject(keyRange);
        }
        var reverse = reverseOrSortOrder === true || reverseOrSortOrder === NoSqlProvider_1.QuerySortOrder.Reverse;
        if (!reverse && this._store.getAll && !offset && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest(this._store.getAll(keyRange, limit));
        }
        var req = this._store.openCursor(keyRange, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    };
    IndexedDbIndex.prototype.getMultiple = function (keyOrKeys) {
        var _this = this;
        var keys = lodash_1.attempt(function () {
            var keys = NoSqlProviderUtils_1.formListOfKeys(keyOrKeys, _this._keyPath);
            if (_this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(_this._keyPath)) {
                return lodash_1.map(keys, function (key) { return NoSqlProviderUtils_1.serializeKeyToString(key, _this._keyPath); });
            }
            return keys;
        });
        if (lodash_1.isError(keys)) {
            return Promise.reject(keys);
        }
        if (this._store.get && !this._fakeComplicatedKeys) {
            return Promise.all(lodash_1.map(keys, function (key) { return IndexedDbProvider.WrapRequest(_this._store.get(key)); })).then(lodash_1.compact);
        }
        return Promise.all(lodash_1.map(keys, function (key) { return _this.getOnly(key); })).then(function (vals) { return lodash_1.compact(lodash_1.flatten(vals)); });
    };
    // Warning: This function can throw, make sure to trap.
    IndexedDbIndex.prototype._getKeyRangeForOnly = function (key) {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(this._keyPath)) {
            return IDBKeyRange.only(NoSqlProviderUtils_1.serializeKeyToString(key, this._keyPath));
        }
        return IDBKeyRange.only(key);
    };
    IndexedDbIndex.prototype.getRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset) {
        var _this = this;
        var keyRange = lodash_1.attempt(function () {
            return _this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keyRange)) {
            return Promise.reject(keyRange);
        }
        var reverse = reverseOrSortOrder === true || reverseOrSortOrder === NoSqlProvider_1.QuerySortOrder.Reverse;
        if (!reverse && this._store.getAll && !offset && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest(this._store.getAll(keyRange, limit));
        }
        var req = this._store.openCursor(keyRange, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    };
    // Warning: This function can throw, make sure to trap.
    IndexedDbIndex.prototype._getKeyRangeForRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils_1.isCompoundKeyPath(this._keyPath)) {
            // IE has to switch to hacky pre-joined-compound-keys
            return IDBKeyRange.bound(NoSqlProviderUtils_1.serializeKeyToString(keyLowRange, this._keyPath), NoSqlProviderUtils_1.serializeKeyToString(keyHighRange, this._keyPath), lowRangeExclusive, highRangeExclusive);
        }
        return IDBKeyRange.bound(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
    };
    IndexedDbIndex.prototype.countAll = function () {
        var req = this._store.count();
        return this._countRequest(req);
    };
    IndexedDbIndex.prototype.countOnly = function (key) {
        var _this = this;
        var keyRange = lodash_1.attempt(function () {
            return _this._getKeyRangeForOnly(key);
        });
        if (lodash_1.isError(keyRange)) {
            return Promise.reject(keyRange);
        }
        var req = this._store.count(keyRange);
        return this._countRequest(req);
    };
    IndexedDbIndex.prototype.countRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var _this = this;
        var keyRange = lodash_1.attempt(function () {
            return _this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keyRange)) {
            return Promise.reject(keyRange);
        }
        var req = this._store.count(keyRange);
        return this._countRequest(req);
    };
    IndexedDbIndex.prototype.getKeysForRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var _this = this;
        var keyRange = lodash_1.attempt(function () {
            return _this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (lodash_1.isError(keyRange)) {
            return Promise.reject(keyRange);
        }
        if (this._store.getAllKeys && !this._fakeComplicatedKeys) {
            return IndexedDbProvider.WrapRequest(this._store.getAllKeys(keyRange));
        }
        var keys = [];
        var req = this._store.openCursor(keyRange, 'next');
        return IndexedDbIndex.iterateOverCursorRequest(req, function (cursor) {
            keys.push(cursor.key);
        }).then(function () {
            return keys;
        });
    };
    IndexedDbIndex.getFromCursorRequest = function (req, limit, offset) {
        var outList = [];
        return this.iterateOverCursorRequest(req, function (cursor) {
            // Typings on cursor are wrong...
            outList.push(cursor.value);
        }, limit, offset).then(function () {
            return outList;
        });
    };
    IndexedDbIndex.prototype._countRequest = function (req) {
        return new Promise(function (resolve, reject) {
            req.onsuccess = function (event) {
                resolve(event.target.result);
            };
            req.onerror = function (ev) {
                reject(ev);
            };
        });
    };
    IndexedDbIndex.iterateOverCursorRequest = function (req, func, limit, offset) {
        return new Promise(function (resolve, reject) {
            var count = 0;
            req.onsuccess = function (event) {
                var cursor = event.target.result;
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
            req.onerror = function (ev) {
                reject(ev);
            };
        });
    };
    return IndexedDbIndex;
}(FullTextSearchHelpers_1.DbIndexFTSFromRangeQueries));
//# sourceMappingURL=IndexedDbProvider.js.map