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

// The DbProvider implementation for Native Sqlite on React Native
interface ReactNativeSqliteDatabase {
    executeSQL(sql: string, params: any[], rowCallback: (rowData: any) => void, completeCallback: (error: any) => void): void;
    close(callback: (error: any) => void): void;
}

export class ReactNativeSqliteProvider extends SqlProviderBase.SqlProviderBase {
    private _reactNativeSqlite: any;
    private _db: ReactNativeSqliteDatabase;

    constructor(reactNativeSqlite: any) {
        super();

        this._reactNativeSqlite = reactNativeSqlite;
    }

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        if (!this._reactNativeSqlite || !this._reactNativeSqlite.open) {
            return SyncTasks.Rejected<void>('No support for react native sqlite in this environment');
        }

        let deferred = SyncTasks.Defer<void>();

        this._reactNativeSqlite.open(dbName + '.sqlite', (error, database) => {
            if (error) {
                deferred.reject('Error opening database: ' + error);
                return;
            }

            this._db = database;

            this._ourVersionChecker(wipeIfExists).then(() => {
                deferred.resolve();
            }, (err) => {
                deferred.reject('Error upgrading database: ' + err);
            });
        });

        return deferred.promise();
    }

    close(): SyncTasks.Promise<void> {
        let task = SyncTasks.Defer<void>();
        this._db.close((err) => {
            if (err) {
                task.reject(err);
            } else {
                task.resolve();
            }
        });
        return task.promise();
    }

    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction> {
        return SyncTasks.Resolved<NoSqlProvider.DbTransaction>(new ReactNativeSqliteTransaction(this._db, this._schema, this._verbose));
    }
}

class ReactNativeSqliteTransaction extends SqlProviderBase.SqlTransaction {
    private _db: ReactNativeSqliteDatabase;

    constructor(db: ReactNativeSqliteDatabase, schema: NoSqlProvider.DbSchema, verbose: boolean) {
        super(schema, verbose, 999);

        // TODO dadere (#333862): Make this an actual transaction
        this._db = db;
    }

    runQuery(sql: string, parameters?: any[]): SyncTasks.Promise<any[]> {
        if (this._verbose) {
            console.log('Query: ' + sql);
        }

        let rows: any[] = [];
        return this._executeQueryWithCallback(sql, parameters, row => {
            rows.push(row);
        }).then(() => {
            return rows;
        });
    }

    getResultsFromQueryWithCallback(sql: string, parameters: any[], callback: (row: any) => void): SyncTasks.Promise<void> {
        return this._executeQueryWithCallback(sql, parameters, (row) => {
            callback(JSON.parse(row.nsp_data));
        });
    }

    private _executeQueryWithCallback(sql: string, parameters: any[], callback: (row: any) => void): SyncTasks.Promise<void> {
        const deferred = SyncTasks.Defer<void>();

        if (this._verbose) {
            console.log('Query: ' + sql);
        }

        this._db.executeSQL(sql, parameters, row => {
            callback(row);
        }, completeErr => {
            if (completeErr) {
                console.log('Query Error: SQL: ' + sql + ', Error: ' + completeErr.toString());
                deferred.reject(completeErr);
                return;
            }

            deferred.resolve();
        });

        return deferred.promise();
    }
}
