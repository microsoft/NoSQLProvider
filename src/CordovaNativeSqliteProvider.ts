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
import NoSqlProviderUtils = require('./NoSqlProviderUtils');
import SqlProviderBase = require('./SqlProviderBase');
import TransactionLockHelper from './TransactionLockHelper';

export interface SqlitePluginDbOptionalParams {
    createFromLocation?: number;
    androidDatabaseImplementation?: number;
    // Database encryption pass phrase
    key?: string;
}

export interface SqlitePluginDbParams extends SqlitePluginDbOptionalParams {
    name: string;
    location: number;
}

export interface SqliteDatabase {
    openDBs: string[];
    transaction(transaction: SQLTransaction, error: SQLTransactionErrorCallback, success: SQLTransactionCallback): void;
    readTransaction(transaction: SQLTransaction, error: SQLTransactionErrorCallback, success: SQLTransactionCallback): void;
    open(success: Function, error: Function): void;
    close(success: Function, error: Function): void;
    executeSql(statement: string, params?: any[], success?: SQLStatementCallback, error?: SQLStatementErrorCallback): void;
}

export interface SqlitePlugin {
    openDatabase(dbInfo: SqlitePluginDbParams, success?: Function, error?: Function): SqliteDatabase;
    deleteDatabase(dbInfo: SqlitePluginDbParams, successCallback?: Function, errorCallback?: Function);
    sqliteFeatures: { isSQLitePlugin: boolean };
}

export class CordovaNativeSqliteProvider extends SqlProviderBase.SqlProviderBase {
    private _lockHelper: TransactionLockHelper;

    // You can use the openOptions object to pass extra optional parameters like androidDatabaseImplementation to the open command
    constructor(private _plugin: SqlitePlugin = window.sqlitePlugin, private _openOptions: SqlitePluginDbOptionalParams = {}) {
        super(true);
    }

    private _db: SqliteDatabase;

    private _closingDefer: SyncTasks.Deferred<void>;

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);
        this._lockHelper = new TransactionLockHelper(schema);

        if (!this._plugin || !this._plugin.openDatabase) {
            return SyncTasks.Rejected<void>('No support for native sqlite in this browser');
        }

        if (typeof (navigator) !== 'undefined' && navigator.userAgent && navigator.userAgent.indexOf('Mobile Crosswalk') !== -1) {
            return SyncTasks.Rejected<void>('Android NativeSqlite is broken, skipping');
        }

        const dbParams = _.extend<SqlitePluginDbParams>({
            name: dbName + '.db',
            location: 2
        }, this._openOptions);

        const task = SyncTasks.Defer<void>();
        this._db = this._plugin.openDatabase(dbParams, () => {
            task.resolve();
        }, () => {
            task.reject('Couldn\'t open database: ' + dbName);
        });

        return task.promise().then(() => {
            return this._ourVersionChecker(wipeIfExists);
        }).fail(() => {
            return SyncTasks.Rejected<void>('Version check failure. Couldn\'t open database: ' + dbName);
        });
    }

    close(): SyncTasks.Promise<void> {
        this._closingDefer = SyncTasks.Defer<void>();
        this._checkClose();
        return this._closingDefer.promise();
    }

    private _checkClose() {
        if (this._closingDefer && this._lockHelper.hasTransaction()) {
            this._db.close(() => {
                this._db = null;
                this._closingDefer.resolve();
            }, (err) => {
                this._closingDefer.reject(err);
            });
        }
    }

    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<SqlProviderBase.SqlTransaction> {
        const storeNamesArr = NoSqlProviderUtils.arrayify(storeNames);
        if (this._closingDefer) {
            return SyncTasks.Rejected('Currently closing provider -- rejecting transaction open');
        }

        return this._lockHelper.checkOpenTransaction(storeNamesArr, writeNeeded).then(() => {
            const deferred = SyncTasks.Defer<SqlProviderBase.SqlTransaction>();

            let ourTrans: SqlProviderBase.SqliteSqlTransaction;
            (writeNeeded ? this._db.transaction : this._db.readTransaction).call(this._db, (trans: SQLTransaction) => {
                ourTrans = new CordovaNativeSqliteTransaction(trans, this._lockHelper, this._schema, storeNamesArr, writeNeeded,
                    this._verbose, 999, this._supportsFTS3);
                deferred.resolve(ourTrans);
            }, (err) => {
                if (ourTrans) {
                    ourTrans.internal_markTransactionClosed();
                } else {
                    // we need to reject transaction only in cases when it's not resolved
                    deferred.reject(err);
                }
                
                this._checkClose();
            }, () => {
                ourTrans.internal_markTransactionClosed();
                this._checkClose();
            });
            return deferred.promise();
        });    
    }
}

class CordovaNativeSqliteTransaction extends SqlProviderBase.SqliteSqlTransaction {
    constructor(protected trans: SQLTransaction,
                protected _lockHelper: TransactionLockHelper,
                schema: NoSqlProvider.DbSchema,
                private _stores: string[],
                private _exclusive: boolean,
                verbose: boolean,
                maxVariables: number,
                supportsFTS3: boolean) {
        super(trans, schema, verbose, maxVariables, supportsFTS3);
    }

    internal_markTransactionClosed(): void {
        super.internal_markTransactionClosed();
        this._lockHelper.transactionComplete(this._stores, this._exclusive);
    }

    protected _requiresUnicodeReplacement(): boolean {
        // TODO dadere (#333863): Possibly limit this to just iOS, since Android seems to handle it properly
        return true;
    }
}
