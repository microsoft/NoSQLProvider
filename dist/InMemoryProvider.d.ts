/**
 * InMemoryProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for a non-persisted in-memory database backing provider.
 */
import { Dictionary } from 'lodash';
import { StoreSchema, DbProvider, DbSchema, DbTransaction, ItemType } from './NoSqlProvider';
export interface StoreData {
    data: Dictionary<ItemType>;
    schema: StoreSchema;
}
export declare class InMemoryProvider extends DbProvider {
    private _stores;
    private _lockHelper;
    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, verbose: boolean): Promise<void>;
    protected _deleteDatabaseInternal(): Promise<void>;
    openTransaction(storeNames: string[], writeNeeded: boolean): Promise<DbTransaction>;
    close(): Promise<void>;
    internal_getStore(name: string): StoreData;
}
