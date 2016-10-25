import SyncTasks = require('synctasks');
import NoSqlProvider = require('./NoSqlProvider');
export declare class InMemoryProvider extends NoSqlProvider.DbProvider {
    private _stores;
    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeConfig: NoSqlProvider.AutoWipeConfig, verbose: boolean): SyncTasks.Promise<void>;
    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction>;
    close(): SyncTasks.Promise<void>;
    getStore(name: string): NoSqlProvider.DbStore;
}
