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
import { ItemType, KeyPathType, KeyType } from './NoSqlProvider';
import NoSqlProviderUtils = require('./NoSqlProviderUtils');
import TransactionLockHelper, { TransactionToken } from './TransactionLockHelper';

export interface StoreData {
    data: _.Dictionary<ItemType>;
    schema: NoSqlProvider.StoreSchema;
}

// Very simple in-memory dbprovider for handling IE inprivate windows (and unit tests, maybe?)
export class InMemoryProvider extends NoSqlProvider.DbProvider {
    private _stores: { [storeName: string]: StoreData } = {};

    private _lockHelper: TransactionLockHelper|undefined;

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        _.each(this._schema!!!.stores, storeSchema => {
            this._stores[storeSchema.name] = { schema: storeSchema, data: {} };
        });

        this._lockHelper = new TransactionLockHelper(schema, true);

        return SyncTasks.Resolved<void>();
    }

    protected _deleteDatabaseInternal() {
        return SyncTasks.Resolved();
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction> {
        return this._lockHelper!!!.openTransaction(storeNames, writeNeeded).then(token =>
            new InMemoryTransaction(this, this._lockHelper!!!, token));
    }

    close(): SyncTasks.Promise<void> {
        return this._lockHelper!!!.closeWhenPossible().then(() => {
            this._stores = {};
        });
    }

    internal_getStore(name: string): StoreData {
        return this._stores[name];
    }
}

// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
class InMemoryTransaction implements NoSqlProvider.DbTransaction {
    private _openTimer: number|undefined;

    private _stores: _.Dictionary<InMemoryStore> = {};

    constructor(private _prov: InMemoryProvider, private _lockHelper: TransactionLockHelper, private _transToken: TransactionToken) {
        // Close the transaction on the next tick.  By definition, anything is completed synchronously here, so after an event tick
        // goes by, there can't have been anything pending.
        this._openTimer = setTimeout(() => {
            this._openTimer = undefined;
            this._commitTransaction();
            this._lockHelper.transactionComplete(this._transToken);
        }, 0) as any as number;
    }

    private _commitTransaction(): void {
        _.each(this._stores, store => {
            store.internal_commitPendingData();
        });
    }

    getCompletionPromise(): SyncTasks.Promise<void> {
        return this._transToken.completionPromise;
    }

    abort(): void {
        _.each(this._stores, store => {
            store.internal_rollbackPendingData();
        });
        this._stores = {};

        if (this._openTimer) {
            clearTimeout(this._openTimer);
            this._openTimer = undefined;
        }

        this._lockHelper.transactionFailed(this._transToken, 'InMemoryTransaction Aborted');
    }

    markCompleted(): void {
        // noop
    }

    getStore(storeName: string): NoSqlProvider.DbStore {
        if (!_.includes(NoSqlProviderUtils.arrayify(this._transToken.storeNames), storeName)) {
            throw new Error('Store not found in transaction-scoped store list: ' + storeName);
        }
        if (this._stores[storeName]) {
            return this._stores[storeName];
        }
        const store = this._prov.internal_getStore(storeName);
        if (!store) {
            throw new Error('Store not found: ' + storeName);
        }
        const ims = new InMemoryStore(this, store);
        this._stores[storeName] = ims;
        return ims;
    }

    internal_isOpen() {
        return !!this._openTimer;
    }
}

class InMemoryStore implements NoSqlProvider.DbStore {
    private _pendingCommitDataChanges: _.Dictionary<ItemType|undefined>|undefined;

    private _committedStoreData: _.Dictionary<ItemType>;
    private _mergedData: _.Dictionary<ItemType>;
    private _storeSchema: NoSqlProvider.StoreSchema;

    constructor(private _trans: InMemoryTransaction, storeInfo: StoreData) {
        this._storeSchema = storeInfo.schema;
        this._committedStoreData = storeInfo.data;

        this._mergedData = this._committedStoreData;
    }

    private _checkDataClone(): void {
        if (!this._pendingCommitDataChanges) {
            this._pendingCommitDataChanges = {};
            this._mergedData = _.assign({}, this._committedStoreData);
        }
    }

    internal_commitPendingData(): void {
        _.each(this._pendingCommitDataChanges, (val, key) => {
            if (val === undefined) {
                delete this._committedStoreData[key];
            } else {
                this._committedStoreData[key] = val;
            }
        });

        this._pendingCommitDataChanges = undefined;
        this._mergedData = this._committedStoreData;
    }

    internal_rollbackPendingData(): void {
        this._pendingCommitDataChanges = undefined;
        this._mergedData = this._committedStoreData;
    }

    get(key: KeyType): SyncTasks.Promise<ItemType|undefined> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }

        const joinedKey = _.attempt(() => {
            return NoSqlProviderUtils.serializeKeyToString(key, this._storeSchema.primaryKeyPath);
        });
        if (_.isError(joinedKey)) {
            return SyncTasks.Rejected(joinedKey);
        }

        return SyncTasks.Resolved(this._mergedData[joinedKey]);
    }

    getMultiple(keyOrKeys: KeyType|KeyType[]): SyncTasks.Promise<ItemType[]> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }

        const joinedKeys = _.attempt(() => {
            return NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (_.isError(joinedKeys)) {
            return SyncTasks.Rejected(joinedKeys);
        }

        return SyncTasks.Resolved(_.compact(_.map(joinedKeys, key => this._mergedData[key])));
    }

    put(itemOrItems: ItemType|ItemType[]): SyncTasks.Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        const err = _.attempt(() => {
            _.each(NoSqlProviderUtils.arrayify(itemOrItems), item => {
                let pk = NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._storeSchema.primaryKeyPath)!!!;

                this._pendingCommitDataChanges!!![pk] = item;
                this._mergedData[pk] = item;
            });
        });
        if (err) {
            return SyncTasks.Rejected<void>(err);
        }
        return SyncTasks.Resolved<void>();
    }

    remove(keyOrKeys: KeyType|KeyType[]): SyncTasks.Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();

        const joinedKeys = _.attempt(() => {
            return NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (_.isError(joinedKeys)) {
            return SyncTasks.Rejected(joinedKeys);
        }

        _.each(joinedKeys, key => {
            this._pendingCommitDataChanges!!![key] = undefined;
            delete this._mergedData[key];
        });
        return SyncTasks.Resolved<void>();
    }

    openPrimaryKey(): NoSqlProvider.DbIndex {
        this._checkDataClone();
        return new InMemoryIndex(this._trans, this._mergedData, undefined, this._storeSchema.primaryKeyPath);
    }

    openIndex(indexName: string): NoSqlProvider.DbIndex {
        let indexSchema = _.find(this._storeSchema.indexes, idx => idx.name === indexName);
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }

        this._checkDataClone();
        return new InMemoryIndex(this._trans, this._mergedData, indexSchema, this._storeSchema.primaryKeyPath);
    }

    clearAllData(): SyncTasks.Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        _.each(this._mergedData, (val, key) => {
            this._pendingCommitDataChanges!!![key] = undefined;
        });
        this._mergedData = {};
        return SyncTasks.Resolved<void>();
    }
}

// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
class InMemoryIndex extends FullTextSearchHelpers.DbIndexFTSFromRangeQueries {
    constructor(private _trans: InMemoryTransaction, private _mergedData: _.Dictionary<ItemType>,
            indexSchema: NoSqlProvider.IndexSchema|undefined, primaryKeyPath: KeyPathType) {
        super(indexSchema, primaryKeyPath);
    }

    // Warning: This function can throw, make sure to trap.
    private _calcChunkedData(): _.Dictionary<ItemType[]>|_.Dictionary<ItemType> {
        if (!this._indexSchema) {
            // Primary key -- use data intact
            return this._mergedData;
        }

        // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
        let data: _.Dictionary<ItemType[]> = {};
        _.each(this._mergedData, item => {
            // Each item may be non-unique so store as an array of items for each key
            let keys: string[]|undefined;
            if (this._indexSchema!!!.fullText) {
                keys = _.map(FullTextSearchHelpers.getFullTextIndexWordsForItem(<string>this._keyPath, item), val =>
                    NoSqlProviderUtils.serializeKeyToString(val, <string>this._keyPath));
            } else if (this._indexSchema!!!.multiEntry) {
                // Have to extract the multiple entries into this alternate table...
                const valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, <string>this._keyPath);
                if (valsRaw) {
                    keys = _.map(NoSqlProviderUtils.arrayify(valsRaw), val =>
                        NoSqlProviderUtils.serializeKeyToString(val, <string>this._keyPath));
                }
            } else {
                keys = [NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._keyPath)!!!];
            }

            _.each(keys, key => {
                if (!data[key]) {
                    data[key] = [item];
                } else {
                    data[key].push(item);
                }
            });
        });
        return data;
    }

    getAll(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }

        const data = _.attempt(() => {
            return this._calcChunkedData();
        });
        if (_.isError(data)) {
            return SyncTasks.Rejected(data);
        }

        const sortedKeys = _.keys(data).sort();
        return this._returnResultsFromKeys(data, sortedKeys, reverse, limit, offset);
    }

    getOnly(key: KeyType, reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]> {
        return this.getRange(key, key, false, false, reverse, limit, offset);
    }

    getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
            reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }

        let data: _.Dictionary<ItemType[]>|_.Dictionary<ItemType>;
        let sortedKeys: string[];
        const err = _.attempt(() => {
            data = this._calcChunkedData();
            sortedKeys = this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).sort();
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        return this._returnResultsFromKeys(data!!!, sortedKeys!!!, reverse, limit, offset);
    }

    // Warning: This function can throw, make sure to trap.
    private _getKeysForRange(data: _.Dictionary<ItemType[]>|_.Dictionary<ItemType>, keyLowRange: KeyType, keyHighRange: KeyType,
            lowRangeExclusive?: boolean, highRangeExclusive?: boolean): string[] {
        const keyLow = NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath);
        const keyHigh = NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath);
        return _.filter(_.keys(data), key =>
            (key > keyLow || (key === keyLow && !lowRangeExclusive)) && (key < keyHigh || (key === keyHigh && !highRangeExclusive)));
    }

    private _returnResultsFromKeys(data: _.Dictionary<ItemType[]>|_.Dictionary<ItemType>, sortedKeys: string[], reverse?: boolean,
            limit?: number, offset?: number) {
        if (reverse) {
            sortedKeys = _.reverse(sortedKeys);
        }

        if (offset) {
            sortedKeys = sortedKeys.slice(offset);
        }

        if (limit) {
            sortedKeys = sortedKeys.slice(0, limit);
        }

        let results = _.map(sortedKeys, key => data[key]);
        return SyncTasks.Resolved(_.flatten(results));
    }

    countAll(): SyncTasks.Promise<number> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }
        const data = _.attempt(() => {
            return this._calcChunkedData();
        });
        if (_.isError(data)) {
            return SyncTasks.Rejected(data);
        }
        return SyncTasks.Resolved(_.keys(data).length);
    }

    countOnly(key: KeyType): SyncTasks.Promise<number> {
        return this.countRange(key, key, false, false);
    }

    countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
            : SyncTasks.Promise<number> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }

        const keys = _.attempt(() => {
            const data = this._calcChunkedData();
            return this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (_.isError(keys)) {
            return SyncTasks.Rejected(keys);
        }

        return SyncTasks.Resolved(keys.length);
    }
}
