/**
 * WebSqlProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for WebSql, a browser storage backing.
 */
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var SyncTasks = require('synctasks');
var SqlProviderBase = require('./SqlProviderBase');
// The DbProvider implementation for WebSQL.  This provider does a bunch of awkward stuff to pretend that a relational SQL store
// is actually a NoSQL store.  We store the raw object as a JSON.encoded string in the nsp_data column, and have an nsp_pk column
// for the primary keypath value, then nsp_i_[index name] columns for each of the indexes.
var WebSqlProvider = (function (_super) {
    __extends(WebSqlProvider, _super);
    function WebSqlProvider() {
        _super.apply(this, arguments);
    }
    WebSqlProvider.prototype.open = function (dbName, schema, wipeIfExists, verbose) {
        var _this = this;
        _super.prototype.open.call(this, dbName, schema, wipeIfExists, verbose);
        if (!window.openDatabase) {
            return SyncTasks.Rejected('No support for WebSQL in this browser');
        }
        this._db = window.openDatabase(dbName, '', dbName, 5 * 1024 * 1024);
        if (!this._db) {
            return SyncTasks.Rejected('Couldn\'t open database: ' + dbName);
        }
        var deferred = SyncTasks.Defer();
        var oldVersion = Number(this._db.version);
        if (oldVersion !== this._schema.version) {
            // Needs a schema upgrade/change
            this._db.changeVersion(this._db.version, this._schema.version.toString(), function (t) {
                var trans = new SqlProviderBase.SqliteSqlTransaction(t, _this._schema, _this._verbose);
                _this._upgradeDb(trans, oldVersion, wipeIfExists).then(function () { deferred.resolve(); }, function () { deferred.reject(); });
            }, function () {
                deferred.reject();
            });
        }
        else if (wipeIfExists) {
            // No version change, but wipe anyway
            this.openTransaction(null, true).then(function (trans) {
                _this._upgradeDb(trans, oldVersion, true).then(function () { deferred.resolve(); }, function () { deferred.reject(); });
            }, function () {
                deferred.reject();
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
        (writeNeeded ? this._db.transaction : this._db.readTransaction).call(this._db, function (trans) {
            deferred.resolve(new SqlProviderBase.SqliteSqlTransaction(trans, _this._schema, _this._verbose));
        }, function (err) {
            deferred.reject(err);
        });
        return deferred.promise();
    };
    return WebSqlProvider;
})(SqlProviderBase.SqlProviderBase);
exports.WebSqlProvider = WebSqlProvider;
