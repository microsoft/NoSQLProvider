import SyncTasks = require('synctasks');
import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');
export declare class NodeSqlite3MemoryDbProvider extends SqlProviderBase.SqlProviderBase {
    private _db;
    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void>;
    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction>;
    close(): SyncTasks.Promise<void>;
    private _getTransaction();
}
