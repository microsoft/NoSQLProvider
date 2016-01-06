/**
 * ReactNativeSqliteProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for react-native-sqlite, a React Native plugin that wraps sqlite.
 */
import SyncTasks = require('synctasks');
import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');
declare class ReactNativeSqliteProvider extends SqlProviderBase.SqlProviderBase {
    private _db;
    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void>;
    close(): SyncTasks.Promise<void>;
    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction>;
}
export = ReactNativeSqliteProvider;
