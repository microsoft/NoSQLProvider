/**
 * NodeSqlite3MemoryDbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for NodeJs to use an in-memory sqlite3-based provider.
 * Largely only used for unit tests.
 */

import sqlite3 = require('sqlite3');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');

export class NodeSqlite3MemoryDbProvider extends SqlProviderBase.SqlProviderBase {
    private _db: sqlite3.Database;

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeConfig: NoSqlProvider.AutoWipeConfig, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeConfig, verbose);

        if (verbose) {
            sqlite3.verbose();
        }

        this._db = new sqlite3.Database(':memory:');

        return this._ourVersionChecker(wipeConfig);
    }

    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction> {
        return SyncTasks.Resolved<NoSqlProvider.DbTransaction>(this._getTransaction());
    }

    close(): SyncTasks.Promise<void> {
        let task = SyncTasks.Defer<void>();
        this._db.close((err) => {
            this._db = null;
            if (err) {
                task.reject(err);
            } else {
                task.resolve();
            }
        });
        return task.promise();
    }

    private _getTransaction(): SqlProviderBase.SqlTransaction {
        return new NodeSqlite3Transaction(this._db, this._schema, this._verbose);
    }
}

class NodeSqlite3Transaction extends SqlProviderBase.SqlTransaction {
    private _db: sqlite3.Database;

    constructor(db: sqlite3.Database, schema: NoSqlProvider.DbSchema, verbose: boolean) {
        super(schema, verbose, 999);

        // TODO dadere (#333862): Make this an actual transaction
        this._db = db;
    }

    runQuery(sql: string, parameters?: any[]): SyncTasks.Promise<any[]> {
        const deferred = SyncTasks.Defer<any[]>();

        if (this._verbose) {
            console.log('Query: ' + sql);
        }

        var stmt = this._db.prepare(sql);
        stmt.bind.apply(stmt, parameters);
        stmt.all((err, rows) => {
            if (err) {
                console.log('Query Error: SQL: ' + sql + ', Error: ' + err.toString());
                deferred.reject(err);
                stmt.finalize();
                return;
            }
            deferred.resolve(rows);
            stmt.finalize();
        });

        return deferred.promise();
    }

    getResultsFromQueryWithCallback(sql: string, parameters: any[], callback: (row: any) => void): SyncTasks.Promise<void> {
        const deferred = SyncTasks.Defer<void>();

        if (this._verbose) {
            console.log('Query: ' + sql);
        }

        var stmt = this._db.prepare(sql);
        stmt.bind.apply(stmt, parameters);
        stmt.each((err, row) => {
            if (err) {
                console.log('Query Error: SQL: ' + sql + ', Error: ' + err.toString());
                deferred.reject(err);
                stmt.finalize();
                return;
            }

            const item = row.nsp_data;
            let ret: any;
            try {
                ret = JSON.parse(item);
            } catch (e) {
                deferred.reject('Error parsing database entry in getResultsFromQueryWithCallback: ' + JSON.stringify(item));
                return;
            }
            try {
                callback(ret);
            } catch (e) {
                deferred.reject('Exception in callback in getResultsFromQueryWithCallback: ' + JSON.stringify(e));
                return;
            }
        }, (err, count) => {
            if (err) {
                console.log('Query Error: SQL: ' + sql + ', Error: ' + err.toString());
                deferred.reject(err);
                stmt.finalize();
                return;
            }
            deferred.resolve();
            stmt.finalize();
        });

        return deferred.promise();
    }
}
