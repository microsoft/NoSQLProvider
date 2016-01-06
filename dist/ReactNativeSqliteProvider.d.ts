/**
 * ReactNativeSqliteProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for react-native-sqlite, a React Native plugin that wraps sqlite.
 */
import SyncTasks = require('synctasks');
import NoSqlProvider = require('./NoSqlProviderInterfaces');
import SqlProviderBase = require('./SqlProviderBase');
export declare class ReactNativeSqliteProvider extends SqlProviderBase.SqlProviderBase {
    private _reactNativeSqlite;
    private _db;
    constructor(reactNativeSqlite: any);
    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void>;
    close(): SyncTasks.Promise<void>;
    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction>;
}
