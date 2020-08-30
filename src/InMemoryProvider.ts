/**
 * InMemoryProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for a non-persisted in-memory database backing provider.
 */

import { attempt, isError, each, includes, compact, map, find, values } from 'lodash';
import { DbIndexFTSFromRangeQueries, getFullTextIndexWordsForItem } from './FullTextSearchHelpers';
import {
    StoreSchema, DbProvider, DbSchema, DbTransaction,
    DbIndex, IndexSchema, DbStore, QuerySortOrder, ItemType, KeyPathType, KeyType
} from './NoSqlProvider';
import { stringCompare } from '@collectable/core';
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
    data: Map<string, ItemType>;
    indices: Map<string, InMemoryIndex>;
    schema: StoreSchema;
}

// Very simple in-memory dbprov ider for handling IE inprivate windows (and unit tests, maybe?)
export class InMemoryProvider extends DbProvider {
    private _stores: Map<string, StoreData> = new Map();

    private _lockHelper: TransactionLockHelper | undefined;

    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, verbose: boolean): Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        each(this._schema!!!.stores, storeSchema => {
            this._stores.set(storeSchema.name, { schema: storeSchema, data: new Map(), indices: new Map() });
        });

        this._lockHelper = new TransactionLockHelper(schema, true);

        return Promise.resolve<void>(void 0);
    }

    protected _deleteDatabaseInternal() {
        return Promise.resolve();
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): Promise<DbTransaction> {
        return this._lockHelper!!!.openTransaction(storeNames, writeNeeded).then((token: any) =>
            new InMemoryTransaction(this, this._lockHelper!!!, token, writeNeeded));
    }

    close(): Promise<void> {
        return this._lockHelper!!!.closeWhenPossible().then(() => {
            this._stores = new Map();
        });
    }

    internal_getStore(name: string): StoreData {
        return this._stores.get(name)!!!;
    }
}

// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
class InMemoryTransaction implements DbTransaction {
    private _stores: Map<string, InMemoryStore> = new Map();
    private _openTimer: number | undefined;
    constructor(
        private _prov: InMemoryProvider, 
        private _lockHelper: TransactionLockHelper, 
        private _transToken: TransactionToken, 
        writeNeeded: boolean) {
         // Close the transaction on the next tick.  By definition, anything is completed synchronously here, so after an event tick
        // goes by, there can't have been anything pending.
        if (writeNeeded) {
            this._openTimer = setTimeout(() => {
                this._openTimer = undefined;
                this._commitTransaction();
                this._lockHelper.transactionComplete(this._transToken);
            }, 0) as any as number;
        } else {
            this._openTimer = undefined;
            this._commitTransaction();
            this._lockHelper.transactionComplete(this._transToken);
        }
        
    }

    private _commitTransaction(): void {
        this._stores.forEach(store => {
            store.internal_commitPendingData();
        });
    }

    getCompletionPromise(): Promise<void> {
        return this._transToken.completionPromise;
    }

    abort(): void {
        this._stores.forEach(store => {
            store.internal_rollbackPendingData();
        });
        
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
        if (this._stores.has(storeName)) {
            return this._stores.get(storeName)!!!;
        }
        const store = this._prov.internal_getStore(storeName);
        if (!store) {
            throw new Error('Store not found: ' + storeName);
        }
        const ims = new InMemoryStore(this, store);
        this._stores.set(storeName, ims);
        return ims;
    }

    internal_isOpen() {
        return !!this._openTimer;
    }
}

class InMemoryStore implements DbStore {
    private _committedStoreData: Map<string, ItemType>;
    private _mergedData: Map<string, ItemType>;
    private _storeSchema: StoreSchema;
    private _indices: Map<string, InMemoryIndex>;
    constructor(private _trans: InMemoryTransaction, storeInfo: StoreData) {
        this._storeSchema = storeInfo.schema;
        this._committedStoreData = new Map(storeInfo.data);
        this._indices = storeInfo.indices;
        this._mergedData = storeInfo.data;
    }

    internal_commitPendingData(): void {
        this._committedStoreData = new Map(this._mergedData);
        // Indices were already updated, theres no need to update them now. 
    }

    internal_rollbackPendingData(): void {
        this._mergedData.clear();
        this._committedStoreData.forEach((val, key) => {
            this._mergedData.set(key, val);
        });
        // Recreate all indexes on a roll back.
        each(this._storeSchema.indexes, (index) => {
            this._indices.set(index.name, new InMemoryIndex(this._mergedData, index, this._storeSchema.primaryKeyPath));
        });
    }

    get(key: KeyType): Promise<ItemType | undefined> {
        const joinedKey = attempt(() => {
            return serializeKeyToString(key, this._storeSchema.primaryKeyPath);
        });
        if (isError(joinedKey)) {
            return Promise.reject(joinedKey);
        }

        return Promise.resolve(this._mergedData.get(joinedKey));
    }

    getMultiple(keyOrKeys: KeyType | KeyType[]): Promise<ItemType[]> {
        const joinedKeys = attempt(() => {
            return formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }

        return Promise.resolve(compact(map(joinedKeys, key => this._mergedData.get(key))));
    }

    put(itemOrItems: ItemType | ItemType[]): Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject<void>('InMemoryTransaction already closed');
        }
        const err = attempt(() => {
            each(arrayify(itemOrItems), item => {
                let pk = getSerializedKeyForKeypath(item, this._storeSchema.primaryKeyPath)!!!;
                const existingItem = this._mergedData.get(pk);
                if (existingItem) {
                    this._removeFromIndices(pk, existingItem);
                }
                this._mergedData.set(pk, item);
                (this.openPrimaryKey() as InMemoryIndex).put(item);
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

        const joinedKeys = attempt(() => {
            return formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }

        return this._removeInternal(joinedKeys);
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
            return this._removeInternal(keys);
        });
    }

    openPrimaryKey(): DbIndex {
        if (!this._indices.get('pk')) {
            this._indices.set('pk', new InMemoryIndex(this._mergedData, undefined as any, this._storeSchema.primaryKeyPath));
        }
        const index = this._indices.get('pk')!!!;
        index.internal_SetTransaction(this._trans);
        return index;
    }

    openIndex(indexName: string): DbIndex {
        let indexSchema = find(this._storeSchema.indexes, idx => idx.name === indexName);
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }

        if (!this._indices.has(indexSchema.name)) {
            this._indices.set(
                indexSchema.name, 
                new InMemoryIndex(this._mergedData, indexSchema, this._storeSchema.primaryKeyPath)
            );
        }
        const index = this._indices.get(indexSchema.name)!!!;
        index.internal_SetTransaction(this._trans);
        return index;
    }

    clearAllData(): Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject<void>('InMemoryTransaction already closed');
        }

        this._mergedData = new Map();
        each(this._storeSchema.indexes, (index) => {
            this._indices.set(index.name, new InMemoryIndex(this._mergedData, index, this._storeSchema.primaryKeyPath));
        });
        return Promise.resolve<void>(void 0);
    }

    private _removeInternal(keys: string[]): Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject<void>('InMemoryTransaction already closed');
        }

        each(keys, key => {
            const existingItem = this._mergedData.get(key);
            this._mergedData.delete(key);
            if (existingItem) {
                this._removeFromIndices(key, existingItem);
            }    
        });

        return Promise.resolve<void>(void 0);
    }

    private _removeFromIndices(key: string, item: ItemType) {
        (this.openPrimaryKey() as InMemoryIndex).remove(key);
        each(this._storeSchema.indexes, (index) => {
            const ind = (this.openIndex(index.name) as InMemoryIndex);
            const keys = ind.internal_getKeysFromItem(item);
            each(keys, key => ind.remove(key));
        });
    }
}

// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
class InMemoryIndex extends DbIndexFTSFromRangeQueries {
    private _rbIndex: RedBlackTreeStructure<string, ItemType[]>;
    private _trans?: InMemoryTransaction;
    constructor(
        _mergedData: Map<string, ItemType>,
        indexSchema: IndexSchema,
        primaryKeyPath: KeyPathType) {
        super(indexSchema, primaryKeyPath);
        this._rbIndex = empty<string, ItemType[]>(stringCompare, true);
        this.put(values(_mergedData), true);
    }

    public internal_SetTransaction(trans: InMemoryTransaction) {
        this._trans = trans;
    }

    public internal_getKeysFromItem(item: ItemType) {
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
        return keys;
    }

    // Warning: This function can throw, make sure to trap.
    public put(itemOrItems: ItemType | ItemType[], skipTransactionOnCreation?: boolean): void {
        if (!skipTransactionOnCreation && !this._trans!.internal_isOpen()) {
            throw new Error('InMemoryTransaction already closed');
        }
        const items = arrayify(itemOrItems);
        // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
        each(items, item => {
            // Each item may be non-unique so store as an array of items for each key
            const keys = this.internal_getKeysFromItem(item);
            
            each(keys, key => {
                if (has(key, this._rbIndex)) {
                    const existingItems = get(key, this._rbIndex)!!! as ItemType[];
                    existingItems.push(item);
                    set<string, ItemType[]>(key, existingItems, this._rbIndex); 
                } else {
                    set(key, [item], this._rbIndex); 
                }
            });
        });
    }

    getMultiple(keyOrKeys: KeyType|KeyType[]): Promise<ItemType[]> {
        const joinedKeys = attempt(() => {
            return formListOfSerializedKeys(keyOrKeys, this._keyPath);
        });
        if (isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }

        let values = [] as ItemType[];
        for (const key of joinedKeys) {
            values = values.concat(get(key, this._rbIndex) as ItemType[]);
        }
        return Promise.resolve(values);
    }

    public remove(key: string, skipTransactionOnCreation?: boolean) {
        if (!skipTransactionOnCreation && !this._trans!.internal_isOpen()) {
            throw new Error('InMemoryTransaction already closed');
        }
        remove(key, this._rbIndex);
    }

    getAll(reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]> {
        limit = limit ? limit : this._rbIndex._size;
        offset = offset ? offset : 0;
        const data = new Array<ItemType>(limit);
        const reverse = (reverseOrSortOrder === true || reverseOrSortOrder === QuerySortOrder.Reverse);
        const iterator = iterateFromIndex(reverse, offset, this._rbIndex);
        let i = 0;
        for (const item of iterator) {
            data[i] = item.value[0];
            i++;
            if (i >= limit) {
                break;
            }
        }
        return Promise.resolve(data);
    }

    getOnly(key: KeyType, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number)
        : Promise<ItemType[]> {
        return this.getRange(key, key, false, false, reverseOrSortOrder, limit, offset);
    }

    getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]> {
        const values = attempt(() => {
            const reverse = reverseOrSortOrder === true || reverseOrSortOrder === QuerySortOrder.Reverse;
            limit = limit ? limit : this._rbIndex._size;
            offset = offset ? offset : 0;
            const keyLow = serializeKeyToString(keyLowRange, this._keyPath);
            const keyHigh = serializeKeyToString(keyHighRange, this._keyPath);
            const iterator = reverse ? iterateKeysFromLast(this._rbIndex) : iterateKeysFromFirst(this._rbIndex);
            let values = [] as ItemType[];
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
                    values = values.concat(get(key, this._rbIndex) as ItemType[]);
                }
            }
            return values;
        });
        if (isError(values)) {
            return Promise.reject(values);
        }

        return Promise.resolve(values);
    }

    getKeysForRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : Promise<any[]> {
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
        return Promise.resolve(this._rbIndex._size);
    }

    countOnly(key: KeyType): Promise<number> {
        return this.countRange(key, key, false, false);
    }

    countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : Promise<number> {
        const keys = attempt(() => {
            return this._getKeysForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (isError(keys)) {
            return Promise.reject(keys);
        }

        return Promise.resolve(keys.length);
    }
}
