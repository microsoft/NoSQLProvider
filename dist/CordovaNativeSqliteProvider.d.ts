import SyncTasks = require('synctasks');
import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');
export declare class CordovaNativeSqliteProvider extends SqlProviderBase.SqlProviderBase {
    private _plugin;
    private _openOptions;
    constructor(_plugin?: SqlitePlugin, _openOptions?: SqlitePluginDbOptionalParams);
    private _db;
    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void>;
    close(): SyncTasks.Promise<void>;
    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<SqlProviderBase.SqlTransaction>;
}
