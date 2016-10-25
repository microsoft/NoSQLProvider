import SyncTasks = require('synctasks');
import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');
export interface SqlitePluginDbOptionalParams {
    createFromLocation?: number;
    androidDatabaseImplementation?: number;
    androidLockWorkaround?: number;
    encriptionPassword?: string;
}
export interface SqlitePluginDbParams extends SqlitePluginDbOptionalParams {
    name: string;
    location: number;
}
export interface SqliteDatabase {
    openDBs: string[];
    addTransaction(transaction: SQLTransaction): void;
    transaction(transaction: SQLTransaction, error: SQLTransactionErrorCallback, success: SQLTransactionCallback): void;
    readTransaction(transaction: SQLTransaction, error: SQLTransactionErrorCallback, success: SQLTransactionCallback): void;
    startNextTransaction(): void;
    abortAllPendingTransactions(): void;
    open(success: Function, error: Function): void;
    close(success: Function, error: Function): void;
    executeSql(statement: string, params?: any[], success?: SQLStatementCallback, error?: SQLStatementErrorCallback): void;
}
export interface SqlitePlugin {
    openDatabase(dbInfo: SqlitePluginDbParams): SqliteDatabase;
    deleteDatabase(dbInfo: SqlitePluginDbParams, successCallback?: Function, errorCallback?: Function): any;
    sqliteFeatures: {
        isSQLitePlugin: boolean;
    };
}
export declare class CordovaNativeSqliteProvider extends SqlProviderBase.SqlProviderBase {
    private _plugin;
    private _openOptions;
    constructor(_plugin?: SqlitePlugin, _openOptions?: SqlitePluginDbOptionalParams);
    private _db;
    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeConfig: NoSqlProvider.AutoWipeConfig, verbose: boolean): SyncTasks.Promise<void>;
    close(): SyncTasks.Promise<void>;
    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<SqlProviderBase.SqlTransaction>;
}
