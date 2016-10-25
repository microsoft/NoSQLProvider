import SyncTasks = require('synctasks');
import NoSqlProvider = require('./NoSqlProvider');
export declare abstract class SqlProviderBase extends NoSqlProvider.DbProvider {
    protected _getDbVersion(): SyncTasks.Promise<number>;
    protected _changeDbVersion(oldVersion: number, newVersion: number): SyncTasks.Promise<SqlTransaction>;
    protected _ourVersionChecker(wipeIfExists: boolean): SyncTasks.Promise<void>;
    protected _upgradeDb(trans: SqlTransaction, oldVersion: number, wipeAnyway: boolean): SyncTasks.Promise<void>;
}
export declare abstract class SqlTransaction implements NoSqlProvider.DbTransaction {
    protected _schema: NoSqlProvider.DbSchema;
    protected _verbose: boolean;
    protected _maxVariables: number;
    constructor(_schema: NoSqlProvider.DbSchema, _verbose: boolean, _maxVariables: number);
    abstract runQuery(sql: string, parameters?: any[]): SyncTasks.Promise<any[]>;
    abstract getResultsFromQueryWithCallback(sql: string, parameters: any[], callback: (obj: any) => void): SyncTasks.Promise<void>;
    getMaxVariables(): number;
    nonQuery(sql: string, parameters?: any[]): SyncTasks.Promise<void>;
    getResultsFromQuery<T>(sql: string, parameters?: any[]): SyncTasks.Promise<T[]>;
    getResultFromQuery<T>(sql: string, parameters?: any[]): SyncTasks.Promise<T>;
    getStore(storeName: string): NoSqlProvider.DbStore;
    protected _requiresUnicodeReplacement(): boolean;
}
export declare class SqliteSqlTransaction extends SqlTransaction {
    private _trans;
    private _pendingQueries;
    constructor(_trans: SQLTransaction, schema: NoSqlProvider.DbSchema, verbose: boolean, maxVariables: number);
    failAllPendingQueries(error: any): void;
    runQuery(sql: string, parameters?: any[]): SyncTasks.Promise<any[]>;
    getResultsFromQueryWithCallback(sql: string, parameters: any[], callback: (obj: any) => void): SyncTasks.Promise<void>;
}
