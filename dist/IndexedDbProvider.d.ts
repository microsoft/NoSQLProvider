import SyncTasks = require('synctasks');
import NoSqlProvider = require('./NoSqlProvider');
declare class IndexedDbProvider extends NoSqlProvider.DbProvider {
    private _db;
    private _test;
    private _dbFactory;
    private _fakeComplicatedKeys;
    constructor(explicitDbFactory?: IDBFactory, explicitDbFactorySupportsCompoundKeys?: boolean);
    static WrapRequest<T>(req: IDBRequest): SyncTasks.Promise<T>;
    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void>;
    close(): SyncTasks.Promise<void>;
    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction>;
}
export = IndexedDbProvider;
