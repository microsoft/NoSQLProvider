/**
 * ReactNativeSqliteProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for react-native-sqlite, a React Native plugin that wraps sqlite.
 */
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var SyncTasks = require('synctasks');
var SqlProviderBase = require('./SqlProviderBase');
var ReactNativeSqliteProvider = (function (_super) {
    __extends(ReactNativeSqliteProvider, _super);
    function ReactNativeSqliteProvider() {
        _super.apply(this, arguments);
    }
    ReactNativeSqliteProvider.prototype.open = function (dbName, schema, wipeIfExists, verbose) {
        var _this = this;
        _super.prototype.open.call(this, dbName, schema, wipeIfExists, verbose);
        var sqlite = require('react-native-sqlite');
        if (!sqlite || !sqlite.open) {
            return SyncTasks.Rejected('No support for react native sqlite in this environment');
        }
        var deferred = SyncTasks.Defer();
        sqlite.open(dbName + '.sqlite', function (error, database) {
            if (error) {
                deferred.reject('Error opening database: ' + error);
                return;
            }
            _this._db = database;
            _this._ourVersionChecker(wipeIfExists).then(function () {
                deferred.resolve();
            }, function (err) {
                deferred.reject('Error upgrading database: ' + err);
            });
        });
        return deferred.promise();
    };
    ReactNativeSqliteProvider.prototype.close = function () {
        var task = SyncTasks.Defer();
        this._db.close(function (err) {
            if (err) {
                task.reject(err);
            }
            else {
                task.resolve();
            }
        });
        return task.promise();
    };
    ReactNativeSqliteProvider.prototype.openTransaction = function (storeNames, writeNeeded) {
        return SyncTasks.Resolved(new ReactNativeSqliteTransaction(this._db, this._schema, this._verbose));
    };
    return ReactNativeSqliteProvider;
})(SqlProviderBase.SqlProviderBase);
exports.ReactNativeSqliteProvider = ReactNativeSqliteProvider;
var ReactNativeSqliteTransaction = (function (_super) {
    __extends(ReactNativeSqliteTransaction, _super);
    function ReactNativeSqliteTransaction(db, schema, verbose) {
        _super.call(this, schema, verbose);
        // TODO dadere (#333862): Make this an actual transaction
        this._db = db;
    }
    ReactNativeSqliteTransaction.prototype.runQuery = function (sql, parameters) {
        if (this._verbose) {
            console.log('Query: ' + sql);
        }
        var rows = [];
        return this._executeQueryWithCallback(sql, parameters, function (row) {
            rows.push(row);
        }).then(function () {
            return rows;
        });
    };
    ReactNativeSqliteTransaction.prototype.getResultsFromQueryWithCallback = function (sql, parameters, callback) {
        return this._executeQueryWithCallback(sql, parameters, function (row) {
            callback(JSON.parse(row.nsp_data));
        });
    };
    ReactNativeSqliteTransaction.prototype._executeQueryWithCallback = function (sql, parameters, callback) {
        var deferred = SyncTasks.Defer();
        if (this._verbose) {
            console.log('Query: ' + sql);
        }
        this._db.executeSQL(sql, parameters, function (row) {
            callback(row);
        }, function (completeErr) {
            if (completeErr) {
                console.log('Query Error: SQL: ' + sql + ', Error: ' + completeErr.toString());
                deferred.reject(completeErr);
                return;
            }
            deferred.resolve();
        });
        return deferred.promise();
    };
    return ReactNativeSqliteTransaction;
})(SqlProviderBase.SqlTransaction);
