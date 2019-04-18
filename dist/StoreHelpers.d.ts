/**
* StoreHelpers.ts
* Author: David de Regt
* Copyright: Microsoft 2017
*
* Reusable helper classes for clients of NoSqlProvider to build more type-safe stores/indexes.
*/
import { DbIndex, QuerySortOrder, FullTextTermResolution, ItemType, KeyType, DbStore } from './NoSqlProvider';
export declare var ErrorCatcher: ((err: any) => Promise<any>) | undefined;
export declare type DBStore<Name extends string, ObjectType, KeyFormat> = string & {
    name?: Name;
    objectType?: ObjectType;
    keyFormat?: KeyFormat;
};
export declare type DBIndex<Store extends DBStore<string, any, any>, IndexKeyFormat> = string & {
    store?: Store;
    indexKeyFormat?: IndexKeyFormat;
};
export declare class SimpleTransactionIndexHelper<ObjectType extends ItemType, IndexKeyFormat extends KeyType> {
    protected _index: DbIndex;
    constructor(_index: DbIndex);
    getAll(reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ObjectType[]>;
    getOnly(key: IndexKeyFormat, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ObjectType[]>;
    getRange(keyLowRange: IndexKeyFormat, keyHighRange: IndexKeyFormat, lowRangeExclusive?: boolean, highRangeExclusive?: boolean, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ObjectType[]>;
    countAll(): Promise<number>;
    countOnly(key: IndexKeyFormat): Promise<number>;
    countRange(keyLowRange: IndexKeyFormat, keyHighRange: IndexKeyFormat, lowRangeExclusive?: boolean, highRangeExclusive?: boolean): Promise<number>;
    fullTextSearch(searchPhrase: string, resolution?: FullTextTermResolution, limit?: number): Promise<ObjectType[]>;
}
export declare class SimpleTransactionStoreHelper<StoreName extends string, ObjectType extends ItemType, KeyFormat extends KeyType> {
    protected _store: DbStore;
    constructor(_store: DbStore, storeName: DBStore<StoreName, ObjectType, KeyFormat>);
    get(key: KeyFormat): Promise<ObjectType | undefined>;
    getAll(sortOrder?: QuerySortOrder): Promise<ObjectType[]>;
    getOnly(key: KeyFormat, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ObjectType[]>;
    getRange(keyLowRange: KeyFormat, keyHighRange: KeyFormat, lowRangeExclusive?: boolean, highRangeExclusive?: boolean, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ObjectType[]>;
    getMultiple(keyOrKeys: KeyFormat | KeyFormat[]): Promise<ObjectType[]>;
    openIndex<IndexKeyFormat extends KeyType>(indexName: DBIndex<DBStore<StoreName, ObjectType, KeyFormat>, IndexKeyFormat>): SimpleTransactionIndexHelper<ObjectType, IndexKeyFormat>;
    openPrimaryKey(): SimpleTransactionIndexHelper<ObjectType, KeyFormat>;
    put(itemOrItems: ObjectType | ReadonlyArray<ObjectType>): Promise<void>;
    remove(keyOrKeys: KeyFormat | KeyFormat[]): Promise<void>;
    clearAllData(): Promise<void>;
}
