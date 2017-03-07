/**
 * InMemoryProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for a non-persisted in-memory database backing provider.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import FullTextSearchHelpers = require('./FullTextSearchHelpers');
import NoSqlProvider = require('./NoSqlProvider');
import NoSqlProviderUtils = require('./NoSqlProviderUtils');
import TransactionLockHelper from './TransactionLockHelper';

export type StoreData = { data: { [pk: string]: any }, schema: NoSqlProvider.StoreSchema };

// Very simple in-memory dbprovider for handling IE inprivate windows (and unit tests, maybe?)
export class InMemoryProvider extends NoSqlProvider.DbProvider {
    private _stores: { [storeName: string]: StoreData } = {};

    private _lockHelper: TransactionLockHelper;

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        _.each(this._schema.stores, storeSchema => {
            this._stores[storeSchema.name] = { schema: storeSchema, data: {} };
        });

        this._lockHelper = new TransactionLockHelper(schema);

        return SyncTasks.Resolved<void>();
    }

    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction> {
        const intStoreNames = NoSqlProviderUtils.arrayify(storeNames);
        return this._lockHelper.checkOpenTransaction(intStoreNames, writeNeeded).then(() => 
            new InMemoryTransaction(this, this._lockHelper, intStoreNames, writeNeeded));
    }

    close(): SyncTasks.Promise<void> {
        return SyncTasks.Resolved<void>();
    }

    internal_getStore(name: string): StoreData {
        return this._stores[name];
    }
}

// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
class InMemoryTransaction implements NoSqlProvider.DbTransaction {
    private _openTimer: number;

    constructor(private _prov: InMemoryProvider, private _lockHelper: TransactionLockHelper, private _storeNames: string[],
            private _exclusive: boolean) {
        // Close the transaction on the next tick.  By definition, anything is completed synchronously here, so after an event tick
        // goes by, there can't have been anything pending.
        this._openTimer = setTimeout(() => {
            this._openTimer = undefined;
            this._lockHelper.transactionComplete(this._storeNames, this._exclusive);
        }, 0) as any as number;
    }

    getStore(storeName: string): NoSqlProvider.DbStore {
        if (!_.includes(NoSqlProviderUtils.arrayify(this._storeNames), storeName)) {
            throw new Error('Store not found in transaction-scoped store list: ' + storeName);
        }
        const store = this._prov.internal_getStore(storeName);
        if (!store) {
            throw new Error('Store not found: ' + storeName);
        }
        return new InMemoryStore(this, store);
    }

    internal_isOpen() {
        return !!this._openTimer;
    }
}

class InMemoryStore implements NoSqlProvider.DbStore {
    constructor(private _trans: InMemoryTransaction, private _storeData: StoreData) {
    }

    get<T>(key: any | any[]): SyncTasks.Promise<T> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }
        let joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._storeData.schema.primaryKeyPath);
        return SyncTasks.Resolved(this._storeData.data[joinedKey]);
    }

    getMultiple<T>(keyOrKeys: any | any[]): SyncTasks.Promise<T[]> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }
        let joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._storeData.schema.primaryKeyPath);
        return SyncTasks.Resolved(_.compact(_.map(joinedKeys, key => this._storeData.data[key])));
    }

    put(itemOrItems: any | any[]): SyncTasks.Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected<void>('InMemoryTransaction already closed');
        }
        _.each(NoSqlProviderUtils.arrayify(itemOrItems), item => {
            let pk = NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._storeData.schema.primaryKeyPath);
            this._storeData.data[pk] = item;
        });
        return SyncTasks.Resolved<void>();
    }

    remove(keyOrKeys: any | any[]): SyncTasks.Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected<void>('InMemoryTransaction already closed');
        }
        let joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._storeData.schema.primaryKeyPath);
        _.each(joinedKeys, key => {
            delete this._storeData.data[key];
        });
        return SyncTasks.Resolved<void>();
    }

    openPrimaryKey(): NoSqlProvider.DbIndex {
        return new InMemoryIndex(this._trans, this._storeData, this._storeData.schema.primaryKeyPath,
            this._storeData.schema.primaryKeyPath, false, false, true);
    }

    openIndex(indexName: string): NoSqlProvider.DbIndex {
        let indexSchema = _.find(this._storeData.schema.indexes, idx => idx.name === indexName);
        if (indexSchema === void 0) {
            return null;
        }

        return new InMemoryIndex(this._trans, this._storeData, indexSchema.keyPath, this._storeData.schema.primaryKeyPath, 
            indexSchema.multiEntry, indexSchema.fullText, false);
    }

    clearAllData(): SyncTasks.Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected<void>('InMemoryTransaction already closed');
        }
        this._storeData.data = {};
        return SyncTasks.Resolved<void>();
    }

    internal_getData() {
        return this._storeData.data;
    }
}

// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
class InMemoryIndex extends FullTextSearchHelpers.DbIndexFTSFromRangeQueries {
    private _data: { [key: string]: any[] };

    constructor(private _trans: InMemoryTransaction, storeData: StoreData, private _keyPath: string | string[],
            primaryKeyPath: string | string[], multiEntry: boolean, fullText: boolean, pk: boolean) {
        super(primaryKeyPath);

        // Construct the index data once

        if (pk) {
            this._data = storeData.data;
        } else {
            // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
            this._data = {};
            _.each(storeData.data, item => {
                // Each item may be non-unique so store as an array of items for each key
                let keys: string[];
                if (fullText) {
                    keys = _.map(FullTextSearchHelpers.getFullTextIndexWordsForItem(<string>this._keyPath, item), val =>
                        NoSqlProviderUtils.serializeKeyToString(val, <string>this._keyPath));
                } else if (multiEntry) {
                    keys = _.map(NoSqlProviderUtils.arrayify(NoSqlProviderUtils.getValueForSingleKeypath(item, <string>this._keyPath)), val =>
                        NoSqlProviderUtils.serializeKeyToString(val, <string>this._keyPath));
                } else {
                    keys = [NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._keyPath)];
                }
                
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
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }
        const sortedKeys = _.keys(this._data).sort();
        return this._returnResultsFromKeys(sortedKeys, reverse, limit, offset);
    }

    getOnly<T>(key: any | any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        return this.getRange(key, key, false, false, reverse, limit, offset);
    }

    getRange<T>(keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
            reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }
        const sortedKeys = this._getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).sort();
        return this._returnResultsFromKeys(sortedKeys, reverse, limit, offset);
    }

    private _getKeysForRange(keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
            : string[] {
        const keyLow = NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath);
        const keyHigh = NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath);
        return _.filter(_.keys(this._data), key =>
            (key > keyLow || (key === keyLow && !lowRangeExclusive)) && (key < keyHigh || (key === keyHigh && !highRangeExclusive)));
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

    countAll(): SyncTasks.Promise<number> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }
        return SyncTasks.Resolved(_.keys(this._data).length);
    }

    countOnly(key: any|any[]): SyncTasks.Promise<number> {
        return this.countRange(key, key, false, false);
    }

    countRange(keyLowRange: any|any[], keyHighRange: any|any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
            : SyncTasks.Promise<number> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }
        const keys = this._getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        return SyncTasks.Resolved(keys.length);
    }
}
