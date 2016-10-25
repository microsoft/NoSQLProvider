/**
 * WebSqlProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for WebSql, a browser storage backing.
 */
"use strict";
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var SyncTasks = require('synctasks');
var NoSqlProvider = require('./NoSqlProvider');
var SqlProviderBase = require('./SqlProviderBase');
// The DbProvider implementation for WebSQL.  This provider does a bunch of awkward stuff to pretend that a relational SQL store
// is actually a NoSQL store.  We store the raw object as a JSON.encoded string in the nsp_data column, and have an nsp_pk column
// for the primary keypath value, then nsp_i_[index name] columns for each of the indexes.
var WebSqlProvider = (function (_super) {
    __extends(WebSqlProvider, _super);
    function WebSqlProvider() {
        _super.apply(this, arguments);
    }
    WebSqlProvider.prototype.open = function (dbName, schema, wipeConfig, verbose) {
        var _this = this;
        _super.prototype.open.call(this, dbName, schema, wipeConfig, verbose);
        if (!window.openDatabase) {
            return SyncTasks.Rejected('No support for WebSQL in this browser');
        }
        try {
            this._db = window.openDatabase(dbName, '', dbName, 10 * 1024 * 1024);
        }
        catch (e) {
            if (e.code === 18) {
                // User rejected the quota attempt
                return SyncTasks.Rejected('User rejected quota allowance');
            }
            return SyncTasks.Rejected('Unknown Exception opening WebSQL database: ' + e.toString());
        }
        if (!this._db) {
            return SyncTasks.Rejected('Couldn\'t open database: ' + dbName);
        }
        var deferred = SyncTasks.Defer();
        var oldVersion = Number(this._db.version);
        var wipe = wipeConfig === NoSqlProvider.AutoWipeConfig.IfExist;
        if (oldVersion !== this._schema.version) {
            // Needs a schema upgrade/change
            if (!wipe && this._schema.version < oldVersion) {
                console.log('Database version too new (' + oldVersion + ') for schema version (' + this._schema.version + '). Wiping!');
                // Note: the reported DB version won't change back to the older number until after you do a put command onto the DB.
                wipe = true;
            }
            this._db.changeVersion(this._db.version, this._schema.version.toString(), function (t) {
                var trans = new SqlProviderBase.SqliteSqlTransaction(t, _this._schema, _this._verbose, 999);
                _this._upgradeDb(trans, oldVersion, wipe).then(function () { deferred.resolve(); }, function () { deferred.reject(); });
            }, function (err) {
                deferred.reject(err);
            });
        }
        else if (wipe) {
            // No version change, but wipe anyway
            this.openTransaction(null, true).then(function (trans) {
                _this._upgradeDb(trans, oldVersion, true).then(function () { deferred.resolve(); }, function () { deferred.reject(); });
            }, function (err) {
                deferred.reject(err);
            });
        }
        else {
            deferred.resolve();
        }
        return deferred.promise();
    };
    WebSqlProvider.prototype.close = function () {
        this._db = null;
        return SyncTasks.Resolved();
    };
    WebSqlProvider.prototype.openTransaction = function (storeNames, writeNeeded) {
        var _this = this;
        var deferred = SyncTasks.Defer();
        var ourTrans = null;
        (writeNeeded ? this._db.transaction : this._db.readTransaction).call(this._db, function (trans) {
            ourTrans = new SqlProviderBase.SqliteSqlTransaction(trans, _this._schema, _this._verbose, 999);
            deferred.resolve(ourTrans);
        }, function (err) {
            if (ourTrans) {
                // Got an error from inside the transaction.  Error out all pending queries on the 
                // transaction since they won't exit out gracefully for whatever reason.
                ourTrans.failAllPendingQueries(err);
            }
            else {
                deferred.reject(err);
            }
        });
        return deferred.promise();
    };
    return WebSqlProvider;
}(SqlProviderBase.SqlProviderBase));
exports.WebSqlProvider = WebSqlProvider;
