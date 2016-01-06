/**
 * NodeSqlite3MemoryDbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for NodeJs to use an in-memory sqlite3-based provider.
 * Largely only used for unit tests.
 */
import SyncTasks = require('synctasks');
import NoSqlProvider = require('./NoSqlProviderInterfaces');
import SqlProviderBase = require('./SqlProviderBase');
export declare class NodeSqlite3MemoryDbProvider extends SqlProviderBase.SqlProviderBase {
    private _sqlite3;
    private _db;
    constructor(sqlite3: any);
    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void>;
    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction>;
    close(): SyncTasks.Promise<void>;
    private _getTransaction();
}
