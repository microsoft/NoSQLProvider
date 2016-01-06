/**
 * WebSqlProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for WebSql, a browser storage backing.
 */

import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');

// The DbProvider implementation for WebSQL.  This provider does a bunch of awkward stuff to pretend that a relational SQL store
// is actually a NoSQL store.  We store the raw object as a JSON.encoded string in the nsp_data column, and have an nsp_pk column
// for the primary keypath value, then nsp_i_[index name] columns for each of the indexes.
class WebSqlProvider extends SqlProviderBase.SqlProviderBase {
    private _db: Database;

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        if (!window.openDatabase) {
            return SyncTasks.Rejected<void>('No support for WebSQL in this browser');
        }

        this._db = window.openDatabase(dbName, '', dbName, 5 * 1024 * 1024);

        if (!this._db) {
            return SyncTasks.Rejected<void>('Couldn\'t open database: ' + dbName);
        }

        const deferred = SyncTasks.Defer<void>();
        let oldVersion = Number(this._db.version);
        if (oldVersion !== this._schema.version) {
            // Needs a schema upgrade/change
            this._db.changeVersion(this._db.version, this._schema.version.toString(), (t) => {
                let trans = new SqlProviderBase.SqliteSqlTransaction(t, this._schema, this._verbose);

                this._upgradeDb(trans, oldVersion, wipeIfExists).then(() => { deferred.resolve(); }, () => { deferred.reject(); });
            }, (/*err*/) => {
                deferred.reject();
            });
        } else if (wipeIfExists) {
            // No version change, but wipe anyway
            this.openTransaction(null, true).then(trans => {
                this._upgradeDb(trans, oldVersion, true).then(() => { deferred.resolve(); }, () => { deferred.reject(); });
            }, () => {
                deferred.reject();
            });
        } else {
            deferred.resolve();
        }
        return deferred.promise();
    }

    close(): SyncTasks.Promise<void> {
        this._db = null;
        return SyncTasks.Resolved<void>();
    }

    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<SqlProviderBase.SqlTransaction> {
        const deferred = SyncTasks.Defer<SqlProviderBase.SqlTransaction>();

        (writeNeeded ? this._db.transaction : this._db.readTransaction).call(this._db,
            trans => {
                deferred.resolve(new SqlProviderBase.SqliteSqlTransaction(trans, this._schema, this._verbose));
            }, (err) => {
                deferred.reject(err);
            });

        return deferred.promise();
    }
}

export = WebSqlProvider;
