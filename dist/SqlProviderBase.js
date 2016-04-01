/**
 * SqlProviderBase.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * Abstract helpers for all NoSqlProvider DbProviders that are based on SQL backings.
 */
"use strict";
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var _ = require('lodash');
var SyncTasks = require('synctasks');
var NoSqlProvider = require('./NoSqlProviderInterfaces');
var NoSqlProviderUtils = require('./NoSqlProviderUtils');
var SqlProviderBase = (function (_super) {
    __extends(SqlProviderBase, _super);
    function SqlProviderBase() {
        _super.apply(this, arguments);
    }
    SqlProviderBase.prototype._getDbVersion = function () {
        return this.openTransaction('metadata', true).then(function (trans) {
            // Create table if needed
            return trans.runQuery('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)').then(function (data) {
                return trans.runQuery('SELECT value from metadata where name=?', ['schemaVersion']).then(function (data) {
                    if (data && data[0] && data[0].value) {
                        return Number(data[0].value) || 0;
                    }
                    return 0;
                });
            });
        });
    };
    SqlProviderBase.prototype._changeDbVersion = function (oldVersion, newVersion) {
        return this.openTransaction('metadata', true).then(function (trans) {
            return trans.runQuery('INSERT OR REPLACE into metadata (\'name\', \'value\') VALUES (\'schemaVersion\', ?)', [newVersion])
                .then(function () {
                return trans;
            });
        });
    };
    SqlProviderBase.prototype._ourVersionChecker = function (wipeIfExists) {
        var _this = this;
        var oldVersion = 0;
        return this._getDbVersion()
            .then(function (version) { oldVersion = version; })
            .then(function () {
            if (oldVersion !== _this._schema.version) {
                // Needs a schema upgrade/change
                return _this._changeDbVersion(oldVersion, _this._schema.version).then(function (trans) {
                    return _this._upgradeDb(trans, oldVersion, wipeIfExists);
                });
            }
            else if (wipeIfExists) {
                // No version change, but wipe anyway
                return _this.openTransaction(null, true).then(function (trans) {
                    return _this._upgradeDb(trans, oldVersion, true);
                });
            }
        });
    };
    SqlProviderBase.prototype._upgradeDb = function (trans, oldVersion, wipeAnyway) {
        var _this = this;
        return trans.runQuery('SELECT tbl_name from sqlite_master WHERE type = \'table\'', [])
            .then(function (rows) {
            var tableNames = _.map(rows, function (row) { return row['tbl_name']; }).filter(function (name) { return name !== '__WebKitDatabaseInfoTable__' &&
                name !== 'metadata'; });
            // Check each table!
            var dropQueries = [];
            if (wipeAnyway || (_this._schema.lastUsableVersion && oldVersion < _this._schema.lastUsableVersion)) {
                // Clear all stores if it's past the usable version
                if (!wipeAnyway) {
                    console.log('Old version detected (' + oldVersion + '), clearing all tables');
                }
                dropQueries = _.map(tableNames, function (name) {
                    trans.runQuery('DROP TABLE ' + name);
                });
                tableNames = [];
            }
            else {
                // Just delete tables we don't care about anymore.  Only care about the raw data in the tables since we're going to
                // re-insert all data anyways, so clear out any multiEntry index tables.
                var tableNamesNeeded_1 = [];
                _this._schema.stores.forEach(function (store) {
                    tableNamesNeeded_1.push(store.name);
                });
                dropQueries = _.filter(tableNames, function (name) { return !_.contains(tableNamesNeeded_1, name); })
                    .map(function (name) { return trans.runQuery('DROP TABLE ' + name); });
                tableNames = _.filter(tableNames, function (name) { return _.contains(tableNamesNeeded_1, name); });
            }
            return SyncTasks.whenAll(dropQueries).then(function () {
                var tableQueries = [];
                // Go over each store and see what needs changing
                _this._schema.stores.forEach(function (storeSchema) {
                    var indexMaker = function () {
                        var indexQueries = _.map(storeSchema.indexes, function (index) {
                            // Go over each index and see if we need to create an index or a table for a multiEntry index
                            if (index.multiEntry) {
                                if (NoSqlProviderUtils.isCompoundKeyPath(index.keyPath)) {
                                    throw 'Can\'t use multiEntry and compound keys';
                                }
                                else {
                                    return trans.runQuery('CREATE TABLE ' + storeSchema.name + '_' + index.name +
                                        ' (nsp_key TEXT, nsp_refrowid INTEGER)').then(function () {
                                        return trans.runQuery('CREATE ' + (index.unique ? 'UNIQUE ' : '') + 'INDEX ' +
                                            storeSchema.name + '_' + index.name + '_pi ON ' + storeSchema.name + '_' +
                                            index.name + ' (nsp_key, nsp_refrowid)');
                                    });
                                }
                            }
                            else {
                                return trans.runQuery('CREATE ' + (index.unique ? 'UNIQUE ' : '') + 'INDEX ' + storeSchema.name +
                                    '_' + index.name + ' ON ' + storeSchema.name + ' (nsp_i_' + index.name + ')');
                            }
                        });
                        return SyncTasks.whenAll(indexQueries);
                    };
                    var tableMaker = function () {
                        // Create the table
                        var fieldList = [];
                        fieldList.push('nsp_pk TEXT PRIMARY KEY');
                        fieldList.push('nsp_data TEXT');
                        var nonMultiIndexes = (storeSchema.indexes || []).filter(function (index) { return !index.multiEntry; });
                        var indexColumns = _.map(nonMultiIndexes, function (index) { return 'nsp_i_' + index.name + ' TEXT'; });
                        fieldList = fieldList.concat(indexColumns);
                        return trans.runQuery('CREATE TABLE ' + storeSchema.name + ' (' + fieldList.join(', ') + ')')
                            .then(indexMaker);
                    };
                    if (_.contains(tableNames, storeSchema.name)) {
                        // If the table exists, we can't read its schema due to websql security rules,
                        // so just make a copy and fully migrate the data over.
                        var tempTablePromise = trans.runQuery('ALTER TABLE ' + storeSchema.name + ' RENAME TO temp_' +
                            storeSchema.name);
                        // Migrate the data over using our existing put functions (since it will do the right things with the indexes)
                        // and delete the temp table.
                        var migrator = function () {
                            var store = trans.getStore(storeSchema.name);
                            var puts = [];
                            return trans.getResultsFromQueryWithCallback('SELECT nsp_data FROM temp_' + storeSchema.name, null, function (obj) {
                                puts.push(store.put(obj));
                            }).then(function () {
                                return SyncTasks.whenAll(puts).then(function () {
                                    return trans.runQuery('DROP TABLE temp_' + storeSchema.name);
                                });
                            });
                        };
                        tableNames = _.filter(tableNames, function (name) { return name !== storeSchema.name; });
                        tableQueries.push(tempTablePromise.then(tableMaker).then(migrator));
                    }
                    else {
                        // Table doesn't exist -- just go ahead and create it without the migration path
                        tableQueries.push(tableMaker());
                    }
                });
                return SyncTasks.whenAll(tableQueries);
            });
        })
            .then(function () { return void 0; });
    };
    return SqlProviderBase;
}(NoSqlProvider.DbProvider));
exports.SqlProviderBase = SqlProviderBase;
// The DbTransaction implementation for the WebSQL DbProvider.  All WebSQL accesses go through the transaction
// object, so this class actually has several helpers for executing SQL queries, getting results from them, etc.
var SqlTransaction = (function () {
    function SqlTransaction(schema, verbose) {
        this._schema = schema;
        this._verbose = verbose;
    }
    SqlTransaction.prototype.nonQuery = function (sql, parameters) {
        return this.runQuery(sql, parameters).then(_.noop);
    };
    SqlTransaction.prototype.getResultsFromQuery = function (sql, parameters) {
        return this.runQuery(sql, parameters).then(function (rows) {
            var rets = [];
            for (var i = 0; i < rows.length; i++) {
                rets.push(JSON.parse(rows[i].nsp_data));
            }
            return rets;
        });
    };
    SqlTransaction.prototype.getResultFromQuery = function (sql, parameters) {
        return this.getResultsFromQuery(sql, parameters)
            .then(function (rets) { return rets.length < 1 ? null : rets[0]; });
    };
    SqlTransaction.prototype.getStore = function (storeName) {
        var storeSchema = _.find(this._schema.stores, function (store) { return store.name === storeName; });
        if (storeSchema === void 0) {
            return null;
        }
        return new SqlStore(this, storeSchema, this._requiresUnicodeReplacement());
    };
    SqlTransaction.prototype._requiresUnicodeReplacement = function () {
        return false;
    };
    return SqlTransaction;
}());
exports.SqlTransaction = SqlTransaction;
// Generic base transaction for anything that matches the syntax of a SQLTransaction interface for executing sql commands.
// Conveniently, this works for both WebSql and cordova's Sqlite plugin.
var SqliteSqlTransaction = (function (_super) {
    __extends(SqliteSqlTransaction, _super);
    function SqliteSqlTransaction(trans, schema, verbose) {
        _super.call(this, schema, verbose);
        this._trans = trans;
    }
    SqliteSqlTransaction.prototype.runQuery = function (sql, parameters) {
        var deferred = SyncTasks.Defer();
        if (this._verbose) {
            console.log('Query: ' + sql);
        }
        this._trans.executeSql(sql, parameters, function (t, rs) {
            var rows = [];
            for (var i = 0; i < rs.rows.length; i++) {
                rows.push(rs.rows.item(i));
            }
            deferred.resolve(rows);
        }, function (t, err) {
            console.log('Query Error: SQL: ' + sql + ', Error: ' + err.message);
            deferred.reject(err);
        });
        return deferred.promise();
    };
    SqliteSqlTransaction.prototype.getResultsFromQueryWithCallback = function (sql, parameters, callback) {
        var deferred = SyncTasks.Defer();
        if (this._verbose) {
            console.log('Query: ' + sql);
        }
        this._trans.executeSql(sql, parameters, function (t, rs) {
            for (var i = 0; i < rs.rows.length; i++) {
                callback(JSON.parse(rs.rows.item(i).nsp_data));
            }
            deferred.resolve();
        }, function (t, err) {
            console.log('Query Error: SQL: ' + sql + ', Error: ' + err.message);
            deferred.reject(err);
        });
        return deferred.promise();
    };
    return SqliteSqlTransaction;
}(SqlTransaction));
exports.SqliteSqlTransaction = SqliteSqlTransaction;
// DbStore implementation for the SQL-based DbProviders.  Implements the getters/setters against the transaction object and all of the
// glue for index/compound key support.
var SqlStore = (function () {
    function SqlStore(trans, schema, replaceUnicode) {
        this._trans = trans;
        this._schema = schema;
        this._replaceUnicode = replaceUnicode;
    }
    SqlStore.prototype.get = function (key) {
        var joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath);
        return this._trans.getResultFromQuery('SELECT nsp_data FROM ' + this._schema.name + ' WHERE nsp_pk = ?', [joinedKey]);
    };
    SqlStore.prototype.getMultiple = function (keyOrKeys) {
        var joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        var qmarks = Array(joinedKeys.length);
        for (var i = 0; i < joinedKeys.length; i++) {
            qmarks[i] = '?';
        }
        return this._trans.getResultsFromQuery('SELECT nsp_data FROM ' + this._schema.name + ' WHERE nsp_pk IN (' +
            qmarks.join(',') + ')', joinedKeys);
    };
    SqlStore.prototype.put = function (itemOrItems) {
        // TODO dadere (#333864): Change to a multi-insert single query, but make sure to take the multiEntry madness into account
        var _this = this;
        var items = NoSqlProviderUtils.arrayify(itemOrItems);
        var fields = ['nsp_pk', 'nsp_data'];
        var qmarks = ['?', '?'];
        var qmarksValues = [];
        var args = [];
        _.each(this._schema.indexes, function (index) {
            if (!index.multiEntry) {
                qmarks.push('?');
                fields.push('nsp_i_' + index.name);
            }
        });
        var qmarkString = qmarks.join(',');
        _.each(items, function (item) {
            qmarksValues.push(qmarkString);
            var serializedData = JSON.stringify(item);
            // For now, until an issue with cordova-ios is fixed (https://issues.apache.org/jira/browse/CB-9435), have to replace
            // \u2028 and 2029 with blanks because otherwise the command boundary with cordova-ios silently eats any strings with them.
            if (_this._replaceUnicode) {
                serializedData = serializedData.replace(SqlStore._unicodeFixer, '');
            }
            args.push(NoSqlProviderUtils.getSerializedKeyForKeypath(item, _this._schema.primaryKeyPath), serializedData);
            _.each(_this._schema.indexes, function (index) {
                if (!index.multiEntry) {
                    args.push(NoSqlProviderUtils.getSerializedKeyForKeypath(item, index.keyPath));
                }
            });
        });
        return this._trans.nonQuery('INSERT OR REPLACE INTO ' + this._schema.name + ' (' + fields.join(',') + ') VALUES (' +
            qmarksValues.join('),(') + ')', args).then(function () {
            if (_.any(_this._schema.indexes, function (index) { return index.multiEntry; })) {
                var queries_1 = [];
                _.each(items, function (item) {
                    queries_1.push(_this._trans.runQuery('SELECT rowid a FROM ' + _this._schema.name + ' WHERE nsp_pk = ?', [NoSqlProviderUtils.getSerializedKeyForKeypath(item, _this._schema.primaryKeyPath)])
                        .then(function (rets) {
                        var rowid = rets[0].a;
                        var inserts = _this._schema.indexes.filter(function (index) { return index.multiEntry; }).map(function (index) {
                            // Have to extract the multiple entries into the alternate table...
                            var valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, index.keyPath);
                            var serializedKeys = NoSqlProviderUtils.arrayify(valsRaw).map(function (val) {
                                return NoSqlProviderUtils.serializeKeyToString(val, index.keyPath);
                            });
                            var valArgs = [], args = [];
                            serializedKeys.forEach(function (val) {
                                valArgs.push('(?, ?)');
                                args.push(val);
                                args.push(rowid);
                            });
                            return _this._trans.nonQuery('DELETE FROM ' + _this._schema.name + '_' + index.name +
                                ' WHERE nsp_refrowid = ?', [rowid]).then(function () {
                                _this._trans.nonQuery('INSERT INTO ' + _this._schema.name + '_' + index.name +
                                    ' (nsp_key, nsp_refrowid) VALUES ' + valArgs.join(','), args);
                            });
                        });
                        return SyncTasks.whenAll(inserts).then(function (rets) { return void 0; });
                    }));
                });
                return SyncTasks.whenAll(queries_1).then(function (rets) { return void 0; });
            }
        });
    };
    SqlStore.prototype.remove = function (keyOrKeys) {
        var _this = this;
        var joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        // PERF: This is optimizable, but it's of questionable utility
        var queries = joinedKeys.map(function (joinedKey) {
            if (_.any(_this._schema.indexes, function (index) { return index.multiEntry; })) {
                // If there's any multientry indexes, we have to do the more complicated version...
                return _this._trans.runQuery('SELECT rowid a FROM ' + _this._schema.name + ' WHERE nsp_pk = ?', [joinedKey]).then(function (rets) {
                    if (rets.length === 0) {
                        return null;
                    }
                    var queries = _this._schema.indexes.filter(function (index) { return index.multiEntry; }).map(function (index) {
                        return _this._trans.nonQuery('DELETE FROM ' + _this._schema.name + '_' + index.name +
                            ' WHERE nsp_refrowid = ?', [rets[0].a]);
                    });
                    queries.push(_this._trans.nonQuery('DELETE FROM ' + _this._schema.name + ' WHERE rowid = ?', [rets[0].a]));
                    return SyncTasks.whenAll(queries);
                });
            }
            return _this._trans.nonQuery('DELETE FROM ' + _this._schema.name + ' WHERE nsp_pk = ?', [joinedKey]);
        });
        return SyncTasks.whenAll(queries).then(function (rets) { return void 0; });
    };
    SqlStore.prototype.openIndex = function (indexName) {
        var indexSchema = _.find(this._schema.indexes, function (index) { return index.name === indexName; });
        if (indexSchema === void 0) {
            return null;
        }
        return new SqlStoreIndex(this._trans, this._schema, indexSchema);
    };
    SqlStore.prototype.openPrimaryKey = function () {
        return new SqlStoreIndex(this._trans, this._schema, null);
    };
    SqlStore.prototype.clearAllData = function () {
        var _this = this;
        var queries = this._schema.indexes.filter(function (index) { return index.multiEntry; }).map(function (index) {
            return _this._trans.nonQuery('DELETE FROM ' + _this._schema.name + '_' + index.name);
        });
        queries.push(this._trans.nonQuery('DELETE FROM ' + this._schema.name));
        return SyncTasks.whenAll(queries).then(function (rets) { return void 0; });
    };
    SqlStore._unicodeFixer = new RegExp('[\u2028\u2029]', 'g');
    return SqlStore;
}());
// DbIndex implementation for SQL-based DbProviders.  Wraps all of the nasty compound key logic and general index traversal logic into
// the appropriate SQL queries.
var SqlStoreIndex = (function () {
    function SqlStoreIndex(trans, storeSchema, indexSchema) {
        this._trans = trans;
        if (!indexSchema) {
            // Going against the PK of the store
            this._tableName = storeSchema.name;
            this._queryColumn = 'nsp_pk';
            this._keyPath = storeSchema.primaryKeyPath;
        }
        else {
            if (indexSchema.multiEntry) {
                this._tableName = storeSchema.name + '_' + indexSchema.name + ' mi LEFT JOIN ' + storeSchema.name +
                    ' ON mi.nsp_refrowid = ' + storeSchema.name + '.rowid';
                this._queryColumn = 'mi.nsp_key';
            }
            else {
                this._tableName = storeSchema.name;
                this._queryColumn = 'nsp_i_' + indexSchema.name;
            }
            this._keyPath = indexSchema.keyPath;
        }
    }
    SqlStoreIndex.prototype._handleQuery = function (sql, args, reverse, limit, offset) {
        sql += ' ORDER BY ' + this._queryColumn + (reverse ? ' DESC' : ' ASC');
        if (limit) {
            sql += ' LIMIT ' + limit.toString();
        }
        if (offset) {
            sql += ' OFFSET ' + offset.toString();
        }
        return this._trans.getResultsFromQuery(sql, args);
    };
    SqlStoreIndex.prototype.getAll = function (reverse, limit, offset) {
        return this._handleQuery('SELECT nsp_data FROM ' + this._tableName, null, reverse, limit, offset);
    };
    SqlStoreIndex.prototype.getOnly = function (key, reverse, limit, offset) {
        var joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._keyPath);
        return this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + this._queryColumn + ' = ?', [joinedKey], reverse, limit, offset);
    };
    SqlStoreIndex.prototype.getRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverse, limit, offset) {
        var checks = [];
        var args = [];
        if (keyLowRange !== null && keyLowRange !== void 0) {
            checks.push(this._queryColumn + (lowRangeExclusive ? ' > ' : ' >= ') + '?');
            args.push(NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath));
        }
        if (keyHighRange !== null && keyHighRange !== void 0) {
            checks.push(this._queryColumn + (highRangeExclusive ? ' < ' : ' <= ') + '?');
            args.push(NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath));
        }
        return this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + checks.join(' AND '), args, reverse, limit, offset);
    };
    return SqlStoreIndex;
}());
