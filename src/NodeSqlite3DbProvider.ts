/**
 * NodeSqlite3DbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for NodeJs to use a sqlite3-based provider.
 * Can pass :memory: to the dbName for it to use an in-memory sqlite instance that's blown away each close() call.
 */

import sqlite3 = require('sqlite3');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');
import TransactionLockHelper, { TransactionToken } from './TransactionLockHelper';

export default class NodeSqlite3DbProvider extends SqlProviderBase.SqlProviderBase {
    private _db: sqlite3.Database|undefined;

    private _lockHelper: TransactionLockHelper|undefined;

    constructor(supportsFTS3 = true) {
        super(supportsFTS3);
    }

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        if (verbose) {
            sqlite3.verbose();
        }

        this._db = new sqlite3.Database(dbName);

        this._lockHelper = new TransactionLockHelper(schema, false);

        return this._ourVersionChecker(wipeIfExists);
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): SyncTasks.Promise<SqlProviderBase.SqlTransaction> {
        if (!this._db) {
            return SyncTasks.Rejected('Can\'t openTransaction on a closed database');
        }
        if (this._verbose) {
            console.log('openTransaction Called with Stores: ' + (storeNames ? storeNames.join(',') : undefined) +
                ', WriteNeeded: ' + writeNeeded);
        }

        return this._lockHelper!!!.openTransaction(storeNames, writeNeeded).then(transToken => {
            if (this._verbose) {
                console.log('openTransaction Resolved with Stores: ' + (storeNames ? storeNames.join(',') : undefined) +
                    ', WriteNeeded: ' + writeNeeded);
            }
            const trans = new NodeSqlite3Transaction(this._db!!!, this._lockHelper!!!, transToken, this._schema!!!, this._verbose!!!,
                this._supportsFTS3);
            if (writeNeeded) {
                return trans.runQuery('BEGIN EXCLUSIVE TRANSACTION').then(ret => trans);
            }
            return trans;
        });
    }

    close(): SyncTasks.Promise<void> {
        if (!this._db) {
            return SyncTasks.Rejected('Database already closed');
        }
        return this._lockHelper!!!.closeWhenPossible().then(() => {
            let task = SyncTasks.Defer<void>();
            this._db!!!.close((err) => {
                this._db = undefined;
                if (err) {
                    task.reject(err);
                } else {
                    task.resolve(void 0);
                }
            });
            return task.promise();
        });
    }

    protected _deleteDatabaseInternal(): SyncTasks.Promise<void> {
        return SyncTasks.Rejected<void>('No support for deleting');
    }
}

class NodeSqlite3Transaction extends SqlProviderBase.SqlTransaction {
    private _openTimer: number|undefined;
    private _openQueryCount = 0;

    constructor(private _db: sqlite3.Database, private _lockHelper: TransactionLockHelper, private _transToken: TransactionToken,
            schema: NoSqlProvider.DbSchema, verbose: boolean, supportsFTS3: boolean) {
        super(schema, verbose, 999, supportsFTS3);

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

            if (!this._transToken.exclusive) {
                this.internal_markTransactionClosed();
                this._lockHelper.transactionComplete(this._transToken);
                return;
            }

            this.runQuery('COMMIT TRANSACTION').then(() => {
                this._clearTimer();
                this.internal_markTransactionClosed();
                this._lockHelper.transactionComplete(this._transToken);
            });
        }, 0) as any as number;
    }

    getCompletionPromise(): SyncTasks.Promise<void> {
        return this._transToken.completionPromise;
    }

    abort(): void {
        this._clearTimer();

        if (!this._transToken.exclusive) {
            this.internal_markTransactionClosed();
            this._lockHelper.transactionFailed(this._transToken, 'NodeSqlite3Transaction Aborted');
            return;
        }

        this.runQuery('ROLLBACK TRANSACTION').always(() => {
            this._clearTimer();
            this.internal_markTransactionClosed();
            this._lockHelper.transactionFailed(this._transToken, 'NodeSqlite3Transaction Aborted');
        });
    }

    runQuery(sql: string, parameters: any[] = []): SyncTasks.Promise<any[]> {
        if (!this._isTransactionOpen()) {
            return SyncTasks.Rejected('SqliteSqlTransaction already closed');
        }

        this._clearTimer();
        this._openQueryCount++;

        const deferred = SyncTasks.Defer<any[]>();

        if (this._verbose) {
            console.log('Query: ' + sql + (parameters ? ', Args: ' + JSON.stringify(parameters) : ''));
        }

        var stmt = this._db.prepare(sql);
        stmt.bind.apply(stmt, parameters);
        stmt.all((err, rows) => {
            this._openQueryCount--;
            if (this._openQueryCount === 0) {
                this._setTimer();
            }

            if (err) {
                console.error('Query Error: SQL: ' + sql + ', Error: ' + err.toString());
                deferred.reject(err);
            } else {
                deferred.resolve(rows);
            }

            stmt.finalize();
        });

        return deferred.promise();
    }
}
