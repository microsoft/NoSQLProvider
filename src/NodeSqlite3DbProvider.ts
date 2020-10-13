/**
 * NodeSqlite3DbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for NodeJs to use a sqlite3-based provider.
 * Can pass :memory: to the dbName for it to use an in-memory sqlite instance that's blown away each close() call.
 */

import { Database, verbose } from 'sqlite3';

import { defer } from './defer';
import { DbSchema } from './NoSqlProvider';
import { SqlProviderBase, SqlTransaction } from  './SqlProviderBase';
import { TransactionLockHelper, TransactionToken } from './TransactionLockHelper';

export default class NodeSqlite3DbProvider extends SqlProviderBase {
    private _db: Database|undefined;

    private _lockHelper: TransactionLockHelper|undefined;

    constructor(supportsFTS3 = true) {
        super(supportsFTS3);
    }

    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, setVerbose: boolean): Promise<void> {
        super.open(dbName, schema, wipeIfExists, setVerbose);

        if (setVerbose) {
            verbose();
        }

        this._db = new Database(dbName);

        this._lockHelper = new TransactionLockHelper(schema, false);

        return this._ourVersionChecker(wipeIfExists);
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): Promise<SqlTransaction> {
        if (!this._db) {
            return Promise.reject('Can\'t openTransaction on a closed database');
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

    close(): Promise<void> {
        if (!this._db) {
            return Promise.reject('Database already closed');
        }
        return this._lockHelper!!!.closeWhenPossible().then(() => {
            let task = defer<void>();
            this._db!!!.close((err) => {
                this._db = undefined;
                if (err) {
                    task.reject(err);
                } else {
                    task.resolve(void 0);
                }
            });
            return task.promise;
        });
    }

    protected _deleteDatabaseInternal(): Promise<void> {
        return Promise.reject<void>('No support for deleting');
    }
}

class NodeSqlite3Transaction extends SqlTransaction {
    private _openTimer: number|undefined;
    private _openQueryCount = 0;

    constructor(private _db: Database, private _lockHelper: TransactionLockHelper, private _transToken: TransactionToken,
            schema: DbSchema, verbose: boolean, supportsFTS3: boolean) {
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

    getCompletionPromise(): Promise<void> {
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

    runQuery(sql: string, parameters: any[] = []): Promise<any[]> {
        if (!this._isTransactionOpen()) {
            return Promise.reject('SqliteSqlTransaction already closed');
        }

        this._clearTimer();
        this._openQueryCount++;

        const deferred = defer<any[]>();

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

        return deferred.promise;
    }
}
