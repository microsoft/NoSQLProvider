/**
 * CordovaNativeSqliteProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for cordova-native-sqlite, a cordova plugin backed by sqlite3.
 * Also works for react-native-sqlite-storage, since it's based on the same bindings, just make sure to pass in an instance
 * of the plugin into the constructor to be used, since window.sqlitePlugin won't exist.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');

export interface SqlitePluginDbOptionalParams {
    createFromLocation?: number;
    androidDatabaseImplementation?: number;
    androidLockWorkaround?: number;
    // Database encryption pass phrase
    key?: string;
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
    openDatabase(dbInfo: SqlitePluginDbParams, success?: Function, error?: Function): SqliteDatabase;
    deleteDatabase(dbInfo: SqlitePluginDbParams, successCallback?: Function, errorCallback?: Function);
    sqliteFeatures: { isSQLitePlugin: boolean }
}

export class CordovaNativeSqliteProvider extends SqlProviderBase.SqlProviderBase {
    // You can use the openOptions object to pass extra optional parameters like androidDatabaseImplementation to the open command
    constructor(private _plugin: SqlitePlugin = window.sqlitePlugin, private _openOptions: SqlitePluginDbOptionalParams = {}) {
        super();
    }

    private _db: SqliteDatabase;

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        if (!this._plugin || !this._plugin.openDatabase) {
            return SyncTasks.Rejected<void>('No support for native sqlite in this browser');
        }

        if (typeof (navigator) !== 'undefined' && navigator.userAgent && navigator.userAgent.indexOf('Mobile Crosswalk') !== -1) {
            return SyncTasks.Rejected<void>('Android NativeSqlite is broken, skipping');
        }

        const dbParams = _.extend<SqlitePluginDbParams, SqlitePluginDbParams>({
            name: dbName + '.db',
            location: 2
        }, this._openOptions);

        const task = SyncTasks.Defer<void>();
        this._db = this._plugin.openDatabase(dbParams, () => {
            task.resolve();
        }, () => {
            console.log('database ', dbName, ' open failed');
            task.reject();
        });

        return task.promise().then(() => {
            return this._ourVersionChecker(wipeIfExists);
        }).fail(() => {
            return SyncTasks.Rejected<void>('Couldn\'t open database: ' + dbName);
        });
    }

    close(): SyncTasks.Promise<void> {
        let task = SyncTasks.Defer<void>();
        this._db.close(() => {
            this._db = null;
            task.resolve();
        }, (err) => {
            task.reject(err);
        });
        return task.promise();
    }

    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<SqlProviderBase.SqlTransaction> {
        const deferred = SyncTasks.Defer<SqlProviderBase.SqlTransaction>();

        (writeNeeded ? this._db.transaction : this._db.readTransaction).call(this._db, (trans: SQLTransaction) => {
            deferred.resolve(new CordovaNativeSqliteTransaction(trans, this._schema, this._verbose, 999));
        }, (err) => {
            deferred.reject(err);
        });

        return deferred.promise();
    }
}

class CordovaNativeSqliteTransaction extends SqlProviderBase.SqliteSqlTransaction {
    protected _requiresUnicodeReplacement(): boolean {
        // TODO dadere (#333863): Possibly limit this to just iOS, since Android seems to handle it properly
        return true;
    }
}
