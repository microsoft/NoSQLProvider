/**
 * InMemoryProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for a non-persisted in-memory database backing provider.
 */

import { attempt, isError, each, Dictionary, includes, compact, map, find, values, flatten } from 'lodash';
import { DbIndexFTSFromRangeQueries, getFullTextIndexWordsForItem } from './FullTextSearchHelpers';
import {
    StoreSchema, DbProvider, DbSchema, DbTransaction,
    DbIndex, IndexSchema, DbStore, QuerySortOrder, ItemType, KeyPathType, KeyType
} from './NoSqlProvider';
import {
    arrayify, serializeKeyToString, formListOfSerializedKeys,
    getSerializedKeyForKeypath, getValueForSingleKeypath
} from './NoSqlProviderUtils';
import { TransactionToken, TransactionLockHelper } from './TransactionLockHelper';
import {
    empty, RedBlackTreeStructure, set, iterateFromIndex,
    iterateKeysFromFirst, get, iterateKeysFromLast, has, remove
} from '@collectable/red-black-tree';
export interface StoreData {
    data: Dictionary<ItemType>;
    schema: StoreSchema;
}

// Very simple in-memory dbprovider for handling IE inprivate windows (and unit tests, maybe?)
export class InMemoryProvider extends DbProvider {
    private _stores: { [storeName: string]: StoreData } = {};

    private _lockHelper: TransactionLockHelper | undefined;

    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, verbose: boolean): Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        each(this._schema!!!.stores, storeSchema => {
            this._stores[storeSchema.name] = { schema: storeSchema, data: {} };
        });

        this._lockHelper = new TransactionLockHelper(schema, true);

        return Promise.resolve<void>(void 0);
    }

    protected _deleteDatabaseInternal() {
        return Promise.resolve();
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): Promise<DbTransaction> {
        return this._lockHelper!!!.openTransaction(storeNames, writeNeeded).then((token: any) =>
            new InMemoryTransaction(this, this._lockHelper!!!, token));
    }

    close(): Promise<void> {
        return this._lockHelper!!!.closeWhenPossible().then(() => {
            this._stores = {};
        });
    }

    internal_getStore(name: string): StoreData {
        return this._stores[name];
    }
}

// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
class InMemoryTransaction implements DbTransaction {
    private _openTimer: number | undefined;

    private _stores: Dictionary<InMemoryStore> = {};

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
        each(this._stores, store => {
            store.internal_commitPendingData();
        });
    }

    getCompletionPromise(): Promise<void> {
        return this._transToken.completionPromise;
    }

    abort(): void {
        each(this._stores, store => {
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

    getStore(storeName: string): DbStore {
        if (!includes(arrayify(this._transToken.storeNames), storeName)) {
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

class InMemoryStore implements DbStore {
    private _pendingCommitDataChanges: Dictionary<ItemType | undefined> | undefined;

    private _committedStoreData: Dictionary<ItemType>;
    private _mergedData: Dictionary<ItemType>;
    private _storeSchema: StoreSchema;
    private _indices: Dictionary<InMemoryIndex>;
    constructor(private _trans: InMemoryTransaction, storeInfo: StoreData) {
        this._storeSchema = storeInfo.schema;
        this._committedStoreData = storeInfo.data;
        this._indices = {};
        this._mergedData = this._committedStoreData;
    }

    private _checkDataClone(): void {
        if (!this._pendingCommitDataChanges) {
            this._pendingCommitDataChanges = {};
            this._mergedData = this._committedStoreData;
        }
    }

    internal_commitPendingData(): void {
        each(this._pendingCommitDataChanges, (val, key) => {
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

    get(key: KeyType): Promise<ItemType | undefined> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }

        const joinedKey = attempt(() => {
            return serializeKeyToString(key, this._storeSchema.primaryKeyPath);
        });
        if (isError(joinedKey)) {
            return Promise.reject(joinedKey);
        }

        return Promise.resolve(this._mergedData[joinedKey]);
    }

    getMultiple(keyOrKeys: KeyType | KeyType[]): Promise<ItemType[]> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }

        const joinedKeys = attempt(() => {
            return formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }

        return Promise.resolve(compact(map(joinedKeys, key => this._mergedData[key])));
    }

    put(itemOrItems: ItemType | ItemType[]): Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        const err = attempt(() => {
            each(arrayify(itemOrItems), item => {
                let pk = getSerializedKeyForKeypath(item, this._storeSchema.primaryKeyPath)!!!;

                this._pendingCommitDataChanges!!![pk] = item;
                this._mergedData[pk] = item;
                if (this._storeSchema.indexes) {
                    for (const index of this._storeSchema.indexes) {
                        (this.openIndex(index.name) as InMemoryIndex).put(item);
                    }
                }
            });
        });
        if (err) {
            return Promise.reject<void>(err);
        }
        return Promise.resolve<void>(void 0);
    }

    remove(keyOrKeys: KeyType | KeyType[]): Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();

        const joinedKeys = attempt(() => {
            return formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }

        return this.removeInternal(joinedKeys);
    }

    removeRange(indexName: string, keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : Promise<void> {

        if (!this._trans.internal_isOpen()) {
            return Promise.reject<void>('InMemoryTransaction already closed');
        }
        const index = attempt(() => {
            return indexName ? this.openIndex(indexName) : this.openPrimaryKey();
        });
        if (!index || isError(index)) {
            return Promise.reject<void>('Index "' + indexName + '" not found');
        }
        return index.getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).then(keys => {
            return this.removeInternal(keys);
        });
    }

    openPrimaryKey(): DbIndex {
        this._checkDataClone();
        if (!this._indices["pk"]) {
            this._indices["pk"] = new InMemoryIndex(this._trans, this._mergedData, undefined as any, this._storeSchema.primaryKeyPath);
        }
        return this._indices["pk"];
    }

    openIndex(indexName: string): DbIndex {
        let indexSchema = find(this._storeSchema.indexes, idx => idx.name === indexName);
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }

        this._checkDataClone();
        if (!this._indices[indexSchema.name]) {
            this._indices[indexSchema.name] = new InMemoryIndex(this._trans, this._mergedData, indexSchema, this._storeSchema.primaryKeyPath);

        }
        return this._indices[indexSchema.name];
    }

    clearAllData(): Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        each(this._mergedData, (_val, key) => {
            this._pendingCommitDataChanges!!![key] = undefined;
        });
        this._mergedData = {};
        return Promise.resolve<void>(void 0);
    }

    private removeInternal(keys: string[]): Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();

        each(keys, key => {
            this._pendingCommitDataChanges!!![key] = undefined;
            delete this._mergedData[key];
            (this.openPrimaryKey() as InMemoryIndex).remove(key);
        });
        each(this._storeSchema.indexes, (index) => {
            this._indices[index.name] = new InMemoryIndex(this._trans, this._mergedData, index, this._storeSchema.primaryKeyPath);
        });

        return Promise.resolve<void>(void 0);
    }
}

// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
class InMemoryIndex extends DbIndexFTSFromRangeQueries {
    private _rbIndex: RedBlackTreeStructure<string, ItemType[]>;
    constructor(private _trans: InMemoryTransaction, _mergedData: Dictionary<ItemType>,
        indexSchema: IndexSchema, primaryKeyPath: KeyPathType) {
        super(indexSchema, primaryKeyPath);
        this._rbIndex = empty<string, ItemType[]>((a: string, b: string) => a.localeCompare(b), false);
        this.put(values(_mergedData));
    }

    // Warning: This function can throw, make sure to trap.
    public put(itemOrItems: ItemType | ItemType[]): void {
        const items = arrayify(itemOrItems);
        // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
        each(items, item => {
            // Each item may be non-unique so store as an array of items for each key
            let keys: string[] | undefined;
            if (this._indexSchema && this._indexSchema!!!.fullText) {
                keys = map(getFullTextIndexWordsForItem(<string>this._keyPath, item), val =>
                    serializeKeyToString(val, <string>this._keyPath));
            } else if (this._indexSchema && this._indexSchema!!!.multiEntry) {
                // Have to extract the multiple entries into this alternate table...
                const valsRaw = getValueForSingleKeypath(item, <string>this._keyPath);
                if (valsRaw) {
                    keys = map(arrayify(valsRaw), val =>
                        serializeKeyToString(val, <string>this._keyPath));
                }
            } else {
                keys = [getSerializedKeyForKeypath(item, this._keyPath)!!!];
            }
            each(keys, key => {
                if (has(key, this._rbIndex)) {
                    const existingItems = get(key, this._rbIndex)!!! as ItemType[];
                    existingItems.push(item);
                    this._rbIndex = set<string, ItemType[]>(key, existingItems, this._rbIndex); 
                } else {
                    this._rbIndex = set(key, [item], this._rbIndex); 
                }
            });
        });
    }

    public remove(key: string) {
        this._rbIndex = remove(key, this._rbIndex);
    }

    getAll(reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }

        limit = limit ? limit : this._rbIndex._size;
        offset = offset ? offset : 0;
        const data = new Array<ItemType[]>(limit);
        const reverse = (reverseOrSortOrder === true || reverseOrSortOrder === QuerySortOrder.Reverse);
        const iterator = iterateFromIndex(reverse, offset, this._rbIndex);
        let i = 0;
        for (const item of iterator) {
            data[i] = item.value;
            i++;
            if (i >= limit) {
                break;
            }
        }
        return Promise.resolve(flatten(data));
    }

    getOnly(key: KeyType, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number)
        : Promise<ItemType[]> {
        return this.getRange(key, key, false, false, reverseOrSortOrder, limit, offset);
    }

    getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }

        const values = attempt(() => {
            const reverse = reverseOrSortOrder === true || reverseOrSortOrder === QuerySortOrder.Reverse;
            limit = limit ? limit : this._rbIndex._size;
            offset = offset ? offset : 0;
            const keyLow = serializeKeyToString(keyLowRange, this._keyPath);
            const keyHigh = serializeKeyToString(keyHighRange, this._keyPath);
            const iterator = reverse ? iterateKeysFromLast(this._rbIndex) : iterateKeysFromFirst(this._rbIndex);
            const values = [] as ItemType[][];
            for (const key of iterator) {
                if (
                    (key > keyLow || (key === keyLow && !lowRangeExclusive)) &&
                    (key < keyHigh || (key === keyHigh && !highRangeExclusive))) {
                    if (offset > 0) {
                        offset--;
                        continue;
                    }
                    if (values.length >= limit) {
                        break;
                    }
                    values.push(get(key, this._rbIndex) as ItemType[]);
                }
            }
            return values;
        });
        if (isError(values)) {
            return Promise.reject(values);
        }

        return Promise.resolve(flatten(values));
    }

    getKeysForRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : Promise<any[]> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        const keys = attempt(() => {
            return this._getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (isError(keys)) {
            return Promise.reject(void 0);
        }
        return Promise.resolve(keys);
    }

    // Warning: This function can throw, make sure to trap.
    private _getKeysForRange(keyLowRange: KeyType, keyHighRange: KeyType,
        lowRangeExclusive?: boolean, highRangeExclusive?: boolean): string[] {
        const keyLow = serializeKeyToString(keyLowRange, this._keyPath);
        const keyHigh = serializeKeyToString(keyHighRange, this._keyPath);
        const iterator = iterateKeysFromFirst(this._rbIndex);
        const keys = [];
        for (const key of iterator) {
            if ((key > keyLow || (key === keyLow && !lowRangeExclusive)) && (key < keyHigh || (key === keyHigh && !highRangeExclusive))) {
                keys.push(key);
            }
        }
        return keys;
    }

    countAll(): Promise<number> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }

        return Promise.resolve(this._rbIndex._size);
    }

    countOnly(key: KeyType): Promise<number> {
        return this.countRange(key, key, false, false);
    }

    countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : Promise<number> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }

        const keys = attempt(() => {
            return this._getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (isError(keys)) {
            return Promise.reject(keys);
        }

        return Promise.resolve(keys.length);
    }
}
