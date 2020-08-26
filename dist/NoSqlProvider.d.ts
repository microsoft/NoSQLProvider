/**
 * NoSqlProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2016
 *
 * Low-level wrapper to expose a nosql-like database which can be backed by
 * numerous different backend store types, invisible to the consumer.  The
 * usage semantics are very similar to IndexedDB.  This file contains most
 * of the helper interfaces, while the specific database providers should
 * be required piecemeal.
 */
import './Promise';
export declare type ItemType = object;
export declare type KeyComponentType = string | number | Date;
export declare type KeyType = KeyComponentType | KeyComponentType[];
export declare type KeyPathType = string | string[];
export declare enum QuerySortOrder {
    None = 0,
    Forward = 1,
    Reverse = 2
}
export interface IndexSchema {
    name: string;
    keyPath: KeyPathType;
    unique?: boolean;
    multiEntry?: boolean;
    fullText?: boolean;
    includeDataInIndex?: boolean;
    doNotBackfill?: boolean;
}
export interface StoreSchema {
    name: string;
    indexes?: IndexSchema[];
    primaryKeyPath: KeyPathType;
    estimatedObjBytes?: number;
}
export interface DbSchema {
    version: number;
    lastUsableVersion?: number;
    stores: StoreSchema[];
}
export declare enum FullTextTermResolution {
    And = 0,
    Or = 1
}
export interface DbIndex {
    getAll(reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]>;
    getOnly(key: KeyType, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]>;
    getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]>;
    countAll(): Promise<number>;
    countOnly(key: KeyType): Promise<number>;
    countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean): Promise<number>;
    fullTextSearch(searchPhrase: string, resolution?: FullTextTermResolution, limit?: number): Promise<ItemType[]>;
}
export interface DbStore {
    get(key: KeyType): Promise<ItemType | undefined>;
    getMultiple(keyOrKeys: KeyType | KeyType[]): Promise<ItemType[]>;
    put(itemOrItems: ItemType | ItemType[]): Promise<void>;
    remove(keyOrKeys: KeyType | KeyType[]): Promise<void>;
    openPrimaryKey(): DbIndex;
    openIndex(indexName: string): DbIndex;
    clearAllData(): Promise<void>;
}
export interface DbTransaction {
    getStore(storeName: string): DbStore;
    getCompletionPromise(): Promise<void>;
    abort(): void;
    markCompleted(): void;
}
export declare abstract class DbProvider {
    protected _dbName: string | undefined;
    protected _schema: DbSchema | undefined;
    protected _verbose: boolean | undefined;
    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, verbose: boolean): Promise<void>;
    abstract close(): Promise<void>;
    abstract openTransaction(storeNames: string[] | undefined, writeNeeded: boolean): Promise<DbTransaction>;
    deleteDatabase(): Promise<void>;
    clearAllData(): Promise<void>;
    protected abstract _deleteDatabaseInternal(): Promise<void>;
    private _getStoreTransaction;
    get(storeName: string, key: KeyType): Promise<ItemType | undefined>;
    getMultiple(storeName: string, keyOrKeys: KeyType | KeyType[]): Promise<ItemType[]>;
    put(storeName: string, itemOrItems: ItemType | ItemType[]): Promise<void>;
    remove(storeName: string, keyOrKeys: KeyType | KeyType[]): Promise<void>;
    private _getStoreIndexTransaction;
    getAll(storeName: string, indexName: string | undefined, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]>;
    getOnly(storeName: string, indexName: string | undefined, key: KeyType, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]>;
    getRange(storeName: string, indexName: string | undefined, keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]>;
    countAll(storeName: string, indexName: string | undefined): Promise<number>;
    countOnly(storeName: string, indexName: string | undefined, key: KeyType): Promise<number>;
    countRange(storeName: string, indexName: string | undefined, keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean): Promise<number>;
    fullTextSearch(storeName: string, indexName: string, searchPhrase: string, resolution?: FullTextTermResolution, limit?: number): Promise<ItemType[]>;
}
export declare function openListOfProviders(providersToTry: DbProvider[], dbName: string, schema: DbSchema, wipeIfExists?: boolean, verbose?: boolean): Promise<DbProvider>;
