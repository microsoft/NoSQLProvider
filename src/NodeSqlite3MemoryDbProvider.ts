/**
 * NodeSqlite3MemoryDbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for NodeJs to use an in-memory sqlite3-based provider.
 * Largely only used for unit tests.
 * Doesn't support actually running BEGIN/COMMIT TRANSACTION queries for transactions, only fakes it with the LockHelper.
 */

import _ = require('lodash');
import sqlite3 = require('sqlite3');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import NoSqlProviderUtils = require('./NoSqlProviderUtils');
import SqlProviderBase = require('./SqlProviderBase');
import TransactionLockHelper from './TransactionLockHelper';

export class NodeSqlite3MemoryDbProvider extends SqlProviderBase.SqlProviderBase {
    private _db: sqlite3.Database;

    private _lockHelper: TransactionLockHelper;

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        if (verbose) {
            sqlite3.verbose();
        }

        this._db = new sqlite3.Database(':memory:');

        this._lockHelper = new TransactionLockHelper(schema);

        return this._ourVersionChecker(wipeIfExists);
    }

    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction> {
        const intStoreNames = NoSqlProviderUtils.arrayify(storeNames);
        return this._lockHelper.checkOpenTransaction(intStoreNames, writeNeeded).then(() =>
            new NodeSqlite3Transaction(this, this._db, this._lockHelper, intStoreNames, writeNeeded, this._schema, this._verbose));
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
}

class NodeSqlite3Transaction extends SqlProviderBase.SqlTransaction {
    private _openTimer: number;
    private _openQueryCount = 0;

    constructor(private _prov: NodeSqlite3MemoryDbProvider, private _db: sqlite3.Database, private _lockHelper: TransactionLockHelper,
            private _storeNames: string[], private _exclusive: boolean, schema: NoSqlProvider.DbSchema, verbose: boolean) {
        super(schema, verbose, 999);

        this._setTimer();
    }

    private _clearTimer(): void {
        if (this._openTimer) {
            clearTimeout(this._openTimer);
            this._openTimer = undefined;
        }
    }

    private _setTimer(): void {
        this._clearTimer();
        this._openTimer = setTimeout(() => {
            this._openTimer = undefined;
            this.internal_markTransactionClosed();
            this._lockHelper.transactionComplete(this._storeNames, this._exclusive);
        }, 0) as any as number;
    }

    runQuery(sql: string, parameters?: any[]): SyncTasks.Promise<any[]> {
        if (!this._isTransactionOpen()) {
            return SyncTasks.Rejected('SqliteSqlTransaction already closed');
        }

        this._clearTimer();
        this._openQueryCount++;

        const deferred = SyncTasks.Defer<any[]>();

        if (this._verbose) {
            console.log('Query: ' + sql);
        }

        var stmt = this._db.prepare(sql);
        stmt.bind.apply(stmt, parameters);
        stmt.all((err, rows) => {
            this._openQueryCount--;
            if (this._openQueryCount === 0) {
                this._setTimer();
            }

            if (err) {
                console.log('Query Error: SQL: ' + sql + ', Error: ' + err.toString());
                deferred.reject(err);
            } else {
                deferred.resolve(rows);
            }

            stmt.finalize();
        });

        return deferred.promise();
    }

    internal_getResultsFromQueryWithCallback(sql: string, parameters: any[], callback: (row: any) => void): SyncTasks.Promise<void> {
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
