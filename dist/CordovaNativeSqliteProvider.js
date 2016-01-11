/**
 * CordovaNativeSqliteProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for cordova-native-sqlite, a cordova plugin backed by sqlite3.
 */
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var SyncTasks = require('synctasks');
var SqlProviderBase = require('./SqlProviderBase');
// The DbProvider implementation for Native Sqlite on cordova
var CordovaNativeSqliteProvider = (function (_super) {
    __extends(CordovaNativeSqliteProvider, _super);
    function CordovaNativeSqliteProvider() {
        _super.apply(this, arguments);
    }
    CordovaNativeSqliteProvider.prototype.open = function (dbName, schema, wipeIfExists, verbose, plugin) {
        if (plugin === void 0) { plugin = window.sqlitePlugin; }
        _super.prototype.open.call(this, dbName, schema, wipeIfExists, verbose);
        if (!plugin || !plugin.openDatabase) {
            return SyncTasks.Rejected('No support for native sqlite in this browser');
        }
        if (typeof (navigator) !== 'undefined' && navigator.userAgent.indexOf('Mobile Crosswalk') !== -1) {
            return SyncTasks.Rejected('Android NativeSqlite is broken, skipping');
        }
        this._db = plugin.openDatabase({
            name: dbName + '.db',
            location: 2,
            androidDatabaseImplementation: 2,
            androidLockWorkaround: 1
        });
        if (!this._db) {
            return SyncTasks.Rejected('Couldn\'t open database: ' + dbName);
        }
        return this._ourVersionChecker(wipeIfExists);
    };
    CordovaNativeSqliteProvider.prototype.close = function () {
        var _this = this;
        var task = SyncTasks.Defer();
        this._db.close(function () {
            _this._db = null;
            task.resolve();
        }, function (err) {
            task.reject(err);
        });
        return task.promise();
    };
    CordovaNativeSqliteProvider.prototype.openTransaction = function (storeNames, writeNeeded) {
        var _this = this;
        var deferred = SyncTasks.Defer();
        (writeNeeded ? this._db.transaction : this._db.readTransaction).call(this._db, function (trans) {
            deferred.resolve(new CordovaNativeSqliteTransaction(trans, _this._schema, _this._verbose));
        }, function (err) {
            deferred.reject(err);
        });
        return deferred.promise();
    };
    return CordovaNativeSqliteProvider;
})(SqlProviderBase.SqlProviderBase);
exports.CordovaNativeSqliteProvider = CordovaNativeSqliteProvider;
var CordovaNativeSqliteTransaction = (function (_super) {
    __extends(CordovaNativeSqliteTransaction, _super);
    function CordovaNativeSqliteTransaction() {
        _super.apply(this, arguments);
    }
    CordovaNativeSqliteTransaction.prototype._requiresUnicodeReplacement = function () {
        // TODO dadere (#333863): Possibly limit this to just iOS, since Android seems to handle it properly
        return true;
    };
    return CordovaNativeSqliteTransaction;
})(SqlProviderBase.SqliteSqlTransaction);
