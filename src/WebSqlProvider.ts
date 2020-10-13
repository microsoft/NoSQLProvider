/**
 * WebSqlProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for WebSql, a browser storage backing.
 */

import { noop } from 'lodash';
import { IDeferred, defer } from './defer';
import { DbSchema } from './NoSqlProvider';
import { SQLDatabase, SqlProviderBase, SqlTransaction, SqliteSqlTransaction, SQLError, SQLTransaction } from './SqlProviderBase';

// Extending interfaces that should be in lib.d.ts but aren't for some reason.
export interface SQLDatabaseCallback {
    (database: SQLDatabase): void;
}

declare global {
    interface Window {
        openDatabase(database_name: string, database_version: string, database_displayname: string,
            database_size?: number, creationCallback?: SQLDatabaseCallback): SQLDatabase;
    }
}

// The DbProvider implementation for WebSQL.  This provider does a bunch of awkward stuff to pretend that a relational SQL store
// is actually a NoSQL store.  We store the raw object as a JSON.encoded string in the nsp_data column, and have an nsp_pk column
// for the primary keypath value, then nsp_i_[index name] columns for each of the indexes.
export class WebSqlProvider extends SqlProviderBase {
    private _db: SQLDatabase|undefined;

    constructor(supportsFTS3 = true) {
        super(supportsFTS3);
    }

    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, verbose: boolean): Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        if (!window.openDatabase) {
            return Promise.reject<void>('No support for WebSQL in this browser');
        }

        try {
            this._db = window.openDatabase(dbName, '', dbName, 10 * 1024 * 1024);
        } catch (e) {
            if (e.code === 18) {
                // User rejected the quota attempt
                return Promise.reject<void>('User rejected quota allowance');
            }

            return Promise.reject<void>('Unknown Exception opening WebSQL database: ' + e.toString());
        }

        if (!this._db) {
            return Promise.reject<void>('Couldn\'t open database: ' + dbName);
        }

        const upgradeDbDeferred = defer<void>();
        let changeVersionDeferred: IDeferred<void> | undefined;
        let oldVersion = Number(this._db.version);
        if (oldVersion !== this._schema!!!.version) {
            // Needs a schema upgrade/change
            if (!wipeIfExists && this._schema!!!.version < oldVersion) {
                console.log('Database version too new (' + oldVersion + ') for schema version (' + this._schema!!!.version + '). Wiping!');
                // Note: the reported DB version won't change back to the older number until after you do a put command onto the DB.
                wipeIfExists = true;
            }
            changeVersionDeferred = defer<void>();

            let errorDetail: string;
            this._db.changeVersion(this._db.version, this._schema!!!.version.toString(), (t) => {
                let trans = new WebSqlTransaction(t, defer<void>().promise, this._schema!!!, this._verbose!!!, 999,
                    this._supportsFTS3);

                this._upgradeDb(trans, oldVersion, wipeIfExists).then(() => {
                    upgradeDbDeferred.resolve(void 0);
                }, err => {
                    errorDetail = err && err.message ? err.message : err.toString();
                    // Got a promise error.  Force the transaction to abort.
                    trans.abort();
                });
            }, (err) => {
                upgradeDbDeferred.reject(err.message + (errorDetail ? ', Detail: ' + errorDetail : ''));
            }, () => {
                changeVersionDeferred!!!.resolve(void 0);
            } );
        } else if (wipeIfExists) {
            // No version change, but wipe anyway
            let errorDetail: string;
            this.openTransaction([], true).then(trans => {
                this._upgradeDb(trans, oldVersion, true).then(() => {
                    upgradeDbDeferred.resolve(void 0);
                }, err => {
                    errorDetail = err && err.message ? err.message : err.toString();
                    // Got a promise error.  Force the transaction to abort.
                    trans.abort();
                });
            }, (err) => {
                upgradeDbDeferred.reject(err.message + (errorDetail ? ', Detail: ' + errorDetail : ''));
            });
        } else {
            upgradeDbDeferred.resolve(void 0);
        }
        return upgradeDbDeferred.promise.then(() => changeVersionDeferred ? changeVersionDeferred.promise : undefined);
    }

    close(): Promise<void> {
        this._db = undefined;
        return Promise.resolve<void>(undefined);
    }

    protected _deleteDatabaseInternal(): Promise<void> {
        return Promise.reject<void>('No support for deleting');
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): Promise<SqlTransaction> {
        if (!this._db) {
            return Promise.reject('Database closed');
        }

        const deferred = defer<SqlTransaction>();

        let ourTrans: SqliteSqlTransaction|undefined;
        let finishDefer: IDeferred<void>|undefined = defer<void>();
        (writeNeeded ? this._db.transaction : this._db.readTransaction).call(this._db,
            (trans: SQLTransaction) => {
                ourTrans = new WebSqlTransaction(trans, finishDefer!!!.promise, this._schema!!!, this._verbose!!!, 999,
                    this._supportsFTS3);
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

        return deferred.promise;
    }
}

class WebSqlTransaction extends SqliteSqlTransaction {
    constructor(protected trans: SQLTransaction,
                private _completionPromise: Promise<void>, 
                schema: DbSchema,
                verbose: boolean,
                maxVariables: number,
                supportsFTS3: boolean) {
        super(trans, schema, verbose, maxVariables, supportsFTS3);
    }

    getCompletionPromise(): Promise<void> {
        return this._completionPromise;
    }
    
    abort(): void {
        // The only way to rollback a websql transaction is by forcing an error (which rolls back the trans):
        // http://stackoverflow.com/questions/16225320/websql-dont-rollback
        this.runQuery('ERROR ME TO DEATH').always(noop);
    }

    getErrorHandlerReturnValue(): boolean {
        // Causes a rollback on websql
        return true;
    }
}
