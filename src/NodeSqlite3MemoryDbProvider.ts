/**
 * NodeSqlite3MemoryDbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for NodeJs to use an in-memory sqlite3-based provider.
 * Largely only used for unit tests.
 */

import SyncTasks = require('synctasks');

import sqlite3 = require('sqlite3');

import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');

class NodeSqlite3MemoryDbProvider extends SqlProviderBase.SqlProviderBase {
    private _db: any;
    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        sqlite3.verbose();

        this._db = new sqlite3.Database(':memory:');

        return this._ourVersionChecker(wipeIfExists);
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
    private _db: any;

    constructor(db: any, schema: NoSqlProvider.DbSchema, verbose: boolean) {
        super(schema, verbose);

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
                return;
            }
            deferred.resolve(rows);
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
                return;
            }
            callback(JSON.parse(row.nsp_data));
        }, (err, count) => {
            if (err) {
                console.log('Query Error: SQL: ' + sql + ', Error: ' + err.toString());
                deferred.reject(err);
                return;
            }
            deferred.resolve();
        });

        return deferred.promise();
    }
}

export = NodeSqlite3MemoryDbProvider;
