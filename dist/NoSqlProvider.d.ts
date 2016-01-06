/**
 * NoSqlProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * Low-level wrapper to expose a nosql-like database which can be backed by
 * numerous different backend store types, invisible to the consumer.  The
 * usage semantics are very similar to IndexedDB.
 */
import SyncTasks = require('synctasks');
export interface IndexSchema {
    name: string;
    keyPath: string | string[];
    unique?: boolean;
    multiEntry?: boolean;
}
export interface StoreSchema {
    name: string;
    indexes?: IndexSchema[];
    primaryKeyPath: string | string[];
}
export interface DbSchema {
    version: number;
    lastUsableVersion?: number;
    stores: StoreSchema[];
}
export interface DbIndex {
    getAll<T>(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    getOnly<T>(key: any | any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    getRange<T>(keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean, reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
}
export interface DbStore {
    get<T>(key: any | any[]): SyncTasks.Promise<T>;
    getMultiple<T>(keyOrKeys: any | any[]): SyncTasks.Promise<T[]>;
    put(itemOrItems: any | any[]): SyncTasks.Promise<void>;
    remove(keyOrKeys: any | any[]): SyncTasks.Promise<void>;
    openPrimaryKey(): DbIndex;
    openIndex(indexName: string): DbIndex;
    clearAllData(): SyncTasks.Promise<void>;
}
export interface DbTransaction {
    getStore(storeName: string): DbStore;
}
export declare abstract class DbProvider {
    protected _schema: DbSchema;
    protected _verbose: boolean;
    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void>;
    abstract close(): SyncTasks.Promise<void>;
    abstract openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<DbTransaction>;
    clearAllData(): SyncTasks.Promise<void>;
    get<T>(storeName: string, key: any | any[]): SyncTasks.Promise<T>;
    getMultiple<T>(storeName: string, keyOrKeys: any | any[]): SyncTasks.Promise<T[]>;
    put(storeName: string, itemOrItems: any | any[]): SyncTasks.Promise<void>;
    remove(storeName: string, keyOrKeys: any | any[]): SyncTasks.Promise<void>;
    getAll<T>(storeName: string, indexName?: string, reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    getOnly<T>(storeName: string, indexName: string, key: any | any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    getRange<T>(storeName: string, indexName: string, keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean, reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
}
export declare function openListOfProviders(providersToTry: DbProvider[], dbName: string, schema: DbSchema, wipeIfExists?: boolean, verbose?: boolean): SyncTasks.Promise<DbProvider>;
export * from './CordovaNativeSqliteProvider';
export * from './IndexedDbProvider';
export * from './InMemoryProvider';
export * from './NodeSqlite3MemoryDbProvider';
export * from './ReactNativeSqliteProvider';
export * from './WebSqlProvider';
