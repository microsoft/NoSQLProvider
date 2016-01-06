/**
 * CordovaNativeSqliteProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for cordova-native-sqlite, a cordova plugin backed by sqlite3.
 */

import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');

// The DbProvider implementation for Native Sqlite on cordova
export class CordovaNativeSqliteProvider extends SqlProviderBase.SqlProviderBase {
    private _db: SqliteDatabase;
    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        if (!window.sqlitePlugin || !window.sqlitePlugin.openDatabase) {
            return SyncTasks.Rejected<void>('No support for native sqlite in this browser');
        }

        if (typeof (navigator) !== 'undefined' && navigator.userAgent.indexOf('Mobile Crosswalk') !== -1) {
            return SyncTasks.Rejected<void>('Android NativeSqlite is broken, skipping');
        }

        this._db = window.sqlitePlugin.openDatabase({
            name: dbName + '.db',
            location: 2,
            androidDatabaseImplementation: 2,
            androidLockWorkaround: 1
        });

        if (!this._db) {
            return SyncTasks.Rejected<void>('Couldn\'t open database: ' + dbName);
        }

        return this._ourVersionChecker(wipeIfExists);
    }

    close(): SyncTasks.Promise<void> {
        let task = SyncTasks.Defer<void>();
        this._db.close(() => {
            this._db = null;
            task.resolve();
        }, (err) => {
            task.reject(err);
        });
        return task.promise();
    }

    openTransaction(storeNames: string | string[], writeNeeded: boolean): SyncTasks.Promise<SqlProviderBase.SqlTransaction> {
        const deferred = SyncTasks.Defer<SqlProviderBase.SqlTransaction>();

        (writeNeeded ? this._db.transaction : this._db.readTransaction).call(this._db, (trans: SQLTransaction) => {
            deferred.resolve(new CordovaNativeSqliteTransaction(trans, this._schema, this._verbose));
        }, (err) => {
            deferred.reject(err);
        });

        return deferred.promise();
    }
}

class CordovaNativeSqliteTransaction extends SqlProviderBase.SqliteSqlTransaction {
    protected _requiresUnicodeReplacement(): boolean {
        // TODO dadere (#333863): Possibly limit this to just iOS, since Android seems to handle it properly
        return true;
    }
}
