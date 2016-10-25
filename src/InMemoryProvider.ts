/**
 * InMemoryProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for a non-persisted in-memory database backing provider.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import NoSqlProviderUtils = require('./NoSqlProviderUtils');

// Very simple in-memory dbprovider for handling IE inprivate windows (and unit tests, maybe?)
export class InMemoryProvider extends NoSqlProvider.DbProvider {
    private _stores: { [storeName: string]: InMemoryStore } = {};

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeConfig: NoSqlProvider.AutoWipeConfig, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeConfig, verbose);

        _.each(this._schema.stores, store => {
            let nStore = new InMemoryStore(store);
            this._stores[store.name] = nStore;
        });

        return SyncTasks.Resolved<void>();
    }

    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction> {
        return SyncTasks.Resolved(new InMemoryTransaction(this));
    }

    close(): SyncTasks.Promise<void> {
        return SyncTasks.Resolved<void>();
    }

    getStore(name: string): NoSqlProvider.DbStore {
        return this._stores[name];
    }
}

// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
class InMemoryTransaction implements NoSqlProvider.DbTransaction {
    private _prov: InMemoryProvider;

    constructor(prov: InMemoryProvider) {
        this._prov = prov;
    }

    getStore(storeName: string): NoSqlProvider.DbStore {
        return this._prov.getStore(storeName);
    }
}

class InMemoryStore implements NoSqlProvider.DbStore {
    private _schema: NoSqlProvider.StoreSchema;

    private _data: { [pk: string]: any } = {};

    constructor(schema: NoSqlProvider.StoreSchema) {
        this._schema = schema;
    }

    get<T>(key: any | any[]): SyncTasks.Promise<T> {
        let joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath);
        return SyncTasks.Resolved(this._data[joinedKey]);
    }

    getMultiple<T>(keyOrKeys: any | any[]): SyncTasks.Promise<T[]> {
        let joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        return SyncTasks.Resolved(_.compact(_.map(joinedKeys, key => this._data[key])));
    }

    put(itemOrItems: any | any[]): SyncTasks.Promise<void> {
        _.each(NoSqlProviderUtils.arrayify(itemOrItems), item => {
            let pk = NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._schema.primaryKeyPath);
            this._data[pk] = item;
        });
        return SyncTasks.Resolved<void>();
    }

    remove(keyOrKeys: any | any[]): SyncTasks.Promise<void> {
        let joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        _.each(joinedKeys, key => {
            delete this._data[key];
        });
        return SyncTasks.Resolved<void>();
    }

    openPrimaryKey(): NoSqlProvider.DbIndex {
        return new InMemoryIndex(this, this._schema.primaryKeyPath, false, true);
    }

    openIndex(indexName: string): NoSqlProvider.DbIndex {
        let indexSchema = _.find(this._schema.indexes, idx => idx.name === indexName);
        if (indexSchema === void 0) {
            return null;
        }

        return new InMemoryIndex(this, indexSchema.keyPath, indexSchema.multiEntry, false);
    }

    clearAllData(): SyncTasks.Promise<void> {
        this._data = {};
        return SyncTasks.Resolved<void>();
    }

    getData() {
        return this._data;
    }
}

// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
class InMemoryIndex implements NoSqlProvider.DbIndex {
    private _keyPath: string | string[];

    private _data: { [key: string]: any[] };

    constructor(store: InMemoryStore, keyPath: string | string[], multiEntry: boolean, pk: boolean) {
        this._keyPath = keyPath;

        // Construct the index data once
        let data = store.getData();

        if (pk) {
            this._data = data;
        } else {
            // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
            this._data = {};
            _.each(data, item => {
                // Each item may be non-unique so store as an array of items for each key
                let keys = multiEntry ?
                    _.map(NoSqlProviderUtils.arrayify(NoSqlProviderUtils.getValueForSingleKeypath(item, <string>this._keyPath)), val =>
                        NoSqlProviderUtils.serializeKeyToString(val, <string>this._keyPath)) :
                    [NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._keyPath)];
                _.each(keys, key => {
                    if (!this._data[key]) {
                        this._data[key] = [item];
                    } else {
                        this._data[key].push(item);
                    }
                });
            });
        }
    }

    getAll<T>(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        let sortedKeys = _.keys(this._data).sort();

        return this._returnResultsFromKeys(sortedKeys, reverse, limit, offset);
    }

    getOnly<T>(key: any | any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        return this.getRange(key, key, false, false, reverse, limit, offset);
    }

    getRange<T>(keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        let keyLow = NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath);
        let keyHigh = NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath);
        let sortedKeys = _.filter(_.keys(this._data), key =>
            (key > keyLow || (key === keyLow && !lowRangeExclusive)) && (key < keyHigh || (key === keyHigh && !highRangeExclusive))
        ).sort();

        return this._returnResultsFromKeys(sortedKeys, reverse, limit, offset);
    }

    private _returnResultsFromKeys(sortedKeys: string[], reverse?: boolean, limit?: number, offset?: number) {
        if (reverse) {
            sortedKeys = _(sortedKeys).reverse().value();
        }

        if (offset) {
            sortedKeys = sortedKeys.slice(offset);
        }

        if (limit) {
            sortedKeys = sortedKeys.slice(0, limit);
        }

        let results = _.map(sortedKeys, key => this._data[key]);
        return SyncTasks.Resolved(_.flatten(results));
    }
}
