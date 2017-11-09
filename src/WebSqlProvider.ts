/**
 * WebSqlProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for WebSql, a browser storage backing.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');

// The DbProvider implementation for WebSQL.  This provider does a bunch of awkward stuff to pretend that a relational SQL store
// is actually a NoSQL store.  We store the raw object as a JSON.encoded string in the nsp_data column, and have an nsp_pk column
// for the primary keypath value, then nsp_i_[index name] columns for each of the indexes.
export class WebSqlProvider extends SqlProviderBase.SqlProviderBase {
    private _db: Database|undefined;

    constructor(supportsFTS3 = true) {
        super(supportsFTS3);
    }

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        if (!window.openDatabase) {
            return SyncTasks.Rejected<void>('No support for WebSQL in this browser');
        }

        try {
            this._db = window.openDatabase(dbName, '', dbName, 10 * 1024 * 1024);
        } catch (e) {
            if (e.code === 18) {
                // User rejected the quota attempt
                return SyncTasks.Rejected<void>('User rejected quota allowance');
            }

            return SyncTasks.Rejected<void>('Unknown Exception opening WebSQL database: ' + e.toString());
        }

        if (!this._db) {
            return SyncTasks.Rejected<void>('Couldn\'t open database: ' + dbName);
        }

        const deferred = SyncTasks.Defer<void>();
        let oldVersion = Number(this._db.version);
        if (oldVersion !== this._schema.version) {
            // Needs a schema upgrade/change
            if (!wipeIfExists && this._schema.version < oldVersion) {
                console.log('Database version too new (' + oldVersion + ') for schema version (' + this._schema.version + '). Wiping!');
                // Note: the reported DB version won't change back to the older number until after you do a put command onto the DB.
                wipeIfExists = true;
            }

            let errorDetail: string;
            this._db.changeVersion(this._db.version, this._schema.version.toString(), (t) => {
                let trans = new WebSqlTransaction(t, SyncTasks.Defer<void>().promise(), this._schema, this._verbose, 999,
                    this._supportsFTS3);

                this._upgradeDb(trans, oldVersion, wipeIfExists).then(() => {
                    deferred.resolve(void 0);
                }, err => {
                    errorDetail = err && err.message ? err.message : err.toString();
                    // Got a promise error.  Force the transaction to abort.
                    trans.abort();
                });
            }, (err) => {
                deferred.reject(err.message + (errorDetail ? ', Detail: ' + errorDetail : ''));
            });
        } else if (wipeIfExists) {
            // No version change, but wipe anyway
            let errorDetail: string;
            this.openTransaction([], true).then(trans => {
                this._upgradeDb(trans, oldVersion, true).then(() => {
                    deferred.resolve(void 0);
                }, err => {
                    errorDetail = err && err.message ? err.message : err.toString();
                    // Got a promise error.  Force the transaction to abort.
                    trans.abort();
                });
            }, (err) => {
                deferred.reject(err.message + (errorDetail ? ', Detail: ' + errorDetail : ''));
            });
        } else {
            deferred.resolve(void 0);
        }
        return deferred.promise();
    }

    close(): SyncTasks.Promise<void> {
        this._db = undefined;
        return SyncTasks.Resolved<void>();
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): SyncTasks.Promise<SqlProviderBase.SqlTransaction> {
        if (!this._db) {
            return SyncTasks.Rejected('Database closed');
        }

        const deferred = SyncTasks.Defer<SqlProviderBase.SqlTransaction>();

        let ourTrans: SqlProviderBase.SqliteSqlTransaction|undefined;
        let finishDefer: SyncTasks.Deferred<void>|undefined = SyncTasks.Defer<void>();
        (writeNeeded ? this._db.transaction : this._db.readTransaction).call(this._db,
            (trans: SQLTransaction) => {
                ourTrans = new WebSqlTransaction(trans, finishDefer!!!.promise(), this._schema, this._verbose, 999, this._supportsFTS3);
                deferred.resolve(ourTrans);
            }, (err: SQLError) => {
                if (ourTrans) {
                    // Got an error from inside the transaction.  Error out all pending queries on the 
                    // transaction since they won't exit out gracefully for whatever reason.
                    ourTrans.failAllPendingQueries(err);
                    ourTrans.internal_markTransactionClosed();
                    if (finishDefer) {
                        finishDefer.reject('WebSqlTransaction Error: ' + err.message);
                        finishDefer = undefined;
                    }
                } else {
                    deferred.reject(err);
                }
            }, () => {
                ourTrans!!!.internal_markTransactionClosed();
                if (finishDefer) {
                    finishDefer.resolve(void 0);
                    finishDefer = undefined;
                }
            });

        return deferred.promise();
    }
}

class WebSqlTransaction extends SqlProviderBase.SqliteSqlTransaction {
    constructor(protected trans: SQLTransaction,
                private _completionPromise: SyncTasks.Promise<void>, 
                schema: NoSqlProvider.DbSchema,
                verbose: boolean,
                maxVariables: number,
                supportsFTS3: boolean) {
        super(trans, schema, verbose, maxVariables, supportsFTS3);
    }

    getCompletionPromise(): SyncTasks.Promise<void> {
        return this._completionPromise;
    }
    
    abort(): void {
        // The only way to rollback a websql transaction is by forcing an error (which rolls back the trans):
        // http://stackoverflow.com/questions/16225320/websql-dont-rollback
        this.runQuery('ERROR ME TO DEATH').always(_.noop);
    }
}
