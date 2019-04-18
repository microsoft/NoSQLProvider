/**
 * IndexedDbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for IndexedDB, a web browser storage module.
 */
import { DbProvider, DbSchema, DbTransaction } from './NoSqlProvider';
declare global {
    interface Window {
        _indexedDB: IDBFactory;
        mozIndexedDB: IDBFactory;
        webkitIndexedDB: IDBFactory;
        msIndexedDB: IDBFactory;
    }
}
export declare class IndexedDbProvider extends DbProvider {
    private _db;
    private _dbFactory;
    private _fakeComplicatedKeys;
    private _lockHelper;
    constructor(explicitDbFactory?: IDBFactory, explicitDbFactorySupportsCompoundKeys?: boolean);
    /**
     * Gets global window object - whether operating in worker or UI thread context.
     * Adapted from: https://stackoverflow.com/questions/7931182/reliably-detect-if-the-script-is-executing-in-a-web-worker
     */
    getWindow(): Window;
    static WrapRequest<T>(req: IDBRequest): Promise<T>;
    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, verbose: boolean): Promise<void>;
    close(): Promise<void>;
    protected _deleteDatabaseInternal(): Promise<void>;
    openTransaction(storeNames: string[], writeNeeded: boolean): Promise<DbTransaction>;
}
