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
var NoSqlProvider = require('./NoSqlProvider');
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
        return this._getDbVersion()
            .then(function (oldVersion) {
            if (oldVersion !== _this._schema.version) {
                // Needs a schema upgrade/change
                if (!wipeIfExists && _this._schema.version < oldVersion) {
                    console.log('Database version too new (' + oldVersion + ') for schema version (' + _this._schema.version + '). Wiping!');
                    wipeIfExists = true;
                }
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
        // Get a list of all tables and indexes on the tables
        return trans.runQuery('SELECT type, name, tbl_name from sqlite_master', [])
            .then(function (rows) {
            var tableNames = [];
            var indexNames = {};
            _.each(rows, function (row) {
                if (row['tbl_name'] === '__WebKitDatabaseInfoTable__' || row['tbl_name'] === 'metadata') {
                    return;
                }
                if (row['type'] === 'table') {
                    tableNames.push(row['name']);
                    if (!indexNames[row['name']]) {
                        indexNames[row['name']] = [];
                    }
                }
                if (row['type'] === 'index') {
                    if (row['name'].substring(0, 17) === 'sqlite_autoindex_') {
                        // auto-index, ignore
                        return;
                    }
                    if (!indexNames[row['tbl_name']]) {
                        indexNames[row['tbl_name']] = [];
                    }
                    indexNames[row['tbl_name']].push(row['name']);
                }
            });
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
                _.each(_this._schema.stores, function (store) {
                    tableNamesNeeded_1.push(store.name);
                });
                dropQueries = _.chain(tableNames).filter(function (name) { return !_.includes(tableNamesNeeded_1, name); })
                    .map(function (name) { return trans.runQuery('DROP TABLE ' + name); }).value();
                tableNames = _.filter(tableNames, function (name) { return _.includes(tableNamesNeeded_1, name); });
            }
            return SyncTasks.all(dropQueries).then(function () {
                var tableQueries = [];
                // Go over each store and see what needs changing
                _.each(_this._schema.stores, function (storeSchema) {
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
                        return SyncTasks.all(indexQueries);
                    };
                    var tableMaker = function () {
                        // Create the table
                        var fieldList = [];
                        fieldList.push('nsp_pk TEXT PRIMARY KEY');
                        fieldList.push('nsp_data TEXT');
                        var nonMultiIndexes = _.filter(storeSchema.indexes || [], function (index) { return !index.multiEntry; });
                        var indexColumns = _.map(nonMultiIndexes, function (index) { return 'nsp_i_' + index.name + ' TEXT'; });
                        fieldList = fieldList.concat(indexColumns);
                        return trans.runQuery('CREATE TABLE ' + storeSchema.name + ' (' + fieldList.join(', ') + ')')
                            .then(indexMaker);
                    };
                    if (_.includes(tableNames, storeSchema.name)) {
                        // If the table exists, we can't read its schema due to websql security rules,
                        // so just make a copy and fully migrate the data over.
                        // Nuke old indexes on the original table (since they don't change names and we don't need them anymore)
                        var nukeIndexesAndRename = SyncTasks.all(_.map(indexNames[storeSchema.name], function (indexName) {
                            return trans.runQuery('DROP INDEX ' + indexName);
                        })).then(function () {
                            // Then rename the table to a temp_[name] table so we can migrate the data out of it
                            return trans.runQuery('ALTER TABLE ' + storeSchema.name + ' RENAME TO temp_' + storeSchema.name);
                        });
                        // Migrate the data over using our existing put functions (since it will do the right things with the indexes)
                        // and delete the temp table.
                        var migrator = function () {
                            var store = trans.getStore(storeSchema.name);
                            var objs = [];
                            return trans.getResultsFromQueryWithCallback('SELECT nsp_data FROM temp_' + storeSchema.name, null, function (obj) {
                                objs.push(obj);
                            }).then(function () {
                                return store.put(objs).then(function () {
                                    return trans.runQuery('DROP TABLE temp_' + storeSchema.name);
                                });
                            });
                        };
                        tableQueries.push(nukeIndexesAndRename.then(tableMaker).then(migrator));
                    }
                    else {
                        // Table doesn't exist -- just go ahead and create it without the migration path
                        tableQueries.push(tableMaker());
                    }
                });
                return SyncTasks.all(tableQueries);
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
    function SqlTransaction(_schema, _verbose, _maxVariables) {
        this._schema = _schema;
        this._verbose = _verbose;
        this._maxVariables = _maxVariables;
    }
    SqlTransaction.prototype.getMaxVariables = function () {
        return this._maxVariables;
    };
    SqlTransaction.prototype.nonQuery = function (sql, parameters) {
        return this.runQuery(sql, parameters).then(_.noop);
    };
    SqlTransaction.prototype.getResultsFromQuery = function (sql, parameters) {
        return this.runQuery(sql, parameters).then(function (rows) {
            var rets = [];
            for (var i = 0; i < rows.length; i++) {
                try {
                    rets.push(JSON.parse(rows[i].nsp_data));
                }
                catch (e) {
                    return SyncTasks.Rejected('Error parsing database entry in getResultsFromQuery: ' + JSON.stringify(rows[i].nsp_data));
                }
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
    function SqliteSqlTransaction(_trans, schema, verbose, maxVariables) {
        _super.call(this, schema, verbose, maxVariables);
        this._trans = _trans;
        this._pendingQueries = [];
    }
    // If an external provider of the transaction determines that the transaction has failed but won't report its failures 
    // (i.e. in the case of WebSQL), we need a way to kick the hanging queries that they're going to fail since otherwise
    // they'll never respond.
    SqliteSqlTransaction.prototype.failAllPendingQueries = function (error) {
        var list = this._pendingQueries;
        this._pendingQueries = [];
        _.each(list, function (query) {
            query.reject(error);
        });
    };
    SqliteSqlTransaction.prototype.runQuery = function (sql, parameters) {
        var _this = this;
        var deferred = SyncTasks.Defer();
        this._pendingQueries.push(deferred);
        if (this._verbose) {
            console.log('Query: ' + sql);
        }
        this._trans.executeSql(sql, parameters, function (t, rs) {
            var index = _.indexOf(_this._pendingQueries, deferred);
            if (index !== -1) {
                var rows = [];
                for (var i = 0; i < rs.rows.length; i++) {
                    rows.push(rs.rows.item(i));
                }
                _this._pendingQueries.splice(index, 1);
                deferred.resolve(rows);
            }
            else {
                console.error('SQL statement resolved twice (success this time): ' + sql);
            }
        }, function (t, err) {
            if (!err) {
                // The cordova-native-sqlite-storage plugin only passes a single parameter here, the error, slightly breaking the interface.
                err = t;
            }
            console.log('Query Error: SQL: ' + sql + ', Error: ' + err.message);
            var index = _.indexOf(_this._pendingQueries, deferred);
            if (index !== -1) {
                _this._pendingQueries.splice(index, 1);
                deferred.reject(err);
            }
            else {
                console.error('SQL statement resolved twice (this time with failure)');
            }
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
                var item = rs.rows.item(i).nsp_data;
                var ret = void 0;
                try {
                    ret = JSON.parse(item);
                }
                catch (e) {
                    deferred.reject('Error parsing database entry in getResultsFromQueryWithCallback: ' + JSON.stringify(item));
                    return;
                }
                try {
                    callback(ret);
                }
                catch (e) {
                    deferred.reject('Exception in callback in getResultsFromQueryWithCallback: ' + JSON.stringify(e));
                    return;
                }
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
        if (joinedKeys.length === 0) {
            return SyncTasks.Resolved([]);
        }
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
        if (items.length === 0) {
            return SyncTasks.Resolved();
        }
        var fields = ['nsp_pk', 'nsp_data'];
        var qmarks = ['?', '?'];
        var args = [];
        _.each(this._schema.indexes, function (index) {
            if (!index.multiEntry) {
                qmarks.push('?');
                fields.push('nsp_i_' + index.name);
            }
        });
        var qmarkString = qmarks.join(',');
        _.each(items, function (item) {
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
        // Need to not use too many variables per insert, so batch the insert if needed.
        var inserts = [];
        var itemPageSize = Math.floor(this._trans.getMaxVariables() / fields.length);
        for (var i = 0; i < items.length; i += itemPageSize) {
            var thisPageCount = Math.min(itemPageSize, items.length - i);
            var qmarksValues = _.fill(new Array(thisPageCount), qmarkString);
            inserts.push(this._trans.nonQuery('INSERT OR REPLACE INTO ' + this._schema.name + ' (' + fields.join(',') + ') VALUES (' +
                qmarksValues.join('),(') + ')', args.splice(0, thisPageCount * fields.length)));
        }
        return SyncTasks.all(inserts).then(function () {
            if (_.some(_this._schema.indexes, function (index) { return index.multiEntry; })) {
                var queries_1 = [];
                _.each(items, function (item) {
                    queries_1.push(_this._trans.runQuery('SELECT rowid a FROM ' + _this._schema.name + ' WHERE nsp_pk = ?', [NoSqlProviderUtils.getSerializedKeyForKeypath(item, _this._schema.primaryKeyPath)])
                        .then(function (rets) {
                        var rowid = rets[0].a;
                        var inserts = _.chain(_this._schema.indexes).filter(function (index) { return index.multiEntry; }).map(function (index) {
                            // Have to extract the multiple entries into the alternate table...
                            var valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, index.keyPath);
                            var serializedKeys = _.map(NoSqlProviderUtils.arrayify(valsRaw), function (val) {
                                return NoSqlProviderUtils.serializeKeyToString(val, index.keyPath);
                            });
                            var valArgs = [], args = [];
                            _.each(serializedKeys, function (val) {
                                valArgs.push('(?, ?)');
                                args.push(val);
                                args.push(rowid);
                            });
                            return _this._trans.nonQuery('DELETE FROM ' + _this._schema.name + '_' + index.name +
                                ' WHERE nsp_refrowid = ?', [rowid]).then(function () {
                                _this._trans.nonQuery('INSERT INTO ' + _this._schema.name + '_' + index.name +
                                    ' (nsp_key, nsp_refrowid) VALUES ' + valArgs.join(','), args);
                            });
                        }).value();
                        return SyncTasks.all(inserts).then(function (rets) { return void 0; });
                    }));
                });
                return SyncTasks.all(queries_1).then(function (rets) { return void 0; });
            }
        });
    };
    SqlStore.prototype.remove = function (keyOrKeys) {
        var _this = this;
        var joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        // PERF: This is optimizable, but it's of questionable utility
        var queries = _.map(joinedKeys, function (joinedKey) {
            if (_.some(_this._schema.indexes, function (index) { return index.multiEntry; })) {
                // If there's any multientry indexes, we have to do the more complicated version...
                return _this._trans.runQuery('SELECT rowid a FROM ' + _this._schema.name + ' WHERE nsp_pk = ?', [joinedKey]).then(function (rets) {
                    if (rets.length === 0) {
                        return null;
                    }
                    var queries = _.chain(_this._schema.indexes).filter(function (index) { return index.multiEntry; }).map(function (index) {
                        return _this._trans.nonQuery('DELETE FROM ' + _this._schema.name + '_' + index.name +
                            ' WHERE nsp_refrowid = ?', [rets[0].a]);
                    }).value();
                    queries.push(_this._trans.nonQuery('DELETE FROM ' + _this._schema.name + ' WHERE rowid = ?', [rets[0].a]));
                    return SyncTasks.all(queries).then(_.noop);
                });
            }
            return _this._trans.nonQuery('DELETE FROM ' + _this._schema.name + ' WHERE nsp_pk = ?', [joinedKey]);
        });
        return SyncTasks.all(queries).then(function (rets) { return void 0; });
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
        var queries = _.chain(this._schema.indexes).filter(function (index) { return index.multiEntry; }).map(function (index) {
            return _this._trans.nonQuery('DELETE FROM ' + _this._schema.name + '_' + index.name);
        }).value();
        queries.push(this._trans.nonQuery('DELETE FROM ' + this._schema.name));
        return SyncTasks.all(queries).then(function (rets) { return void 0; });
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
        var _a = this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive), checks = _a.checks, args = _a.args;
        return this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + checks.join(' AND '), args, reverse, limit, offset);
    };
    SqlStoreIndex.prototype._getRangeChecks = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
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
        return { checks: checks, args: args };
    };
    SqlStoreIndex.prototype.countAll = function () {
        return this._trans.getResultFromQuery('SELECT COUNT(*) cnt FROM ' + this._tableName).then(function (result) { return result['cnt']; });
    };
    SqlStoreIndex.prototype.countOnly = function (key) {
        var joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._keyPath);
        return this._trans.getResultFromQuery('SELECT COUNT(*) cnt FROM ' + this._tableName + ' WHERE ' + this._queryColumn
            + ' = ?', [joinedKey]).then(function (result) { return result['cnt']; });
    };
    SqlStoreIndex.prototype.countRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var _a = this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive), checks = _a.checks, args = _a.args;
        return this._trans.getResultFromQuery('SELECT COUNT(*) cnt FROM ' + this._tableName + ' WHERE ' + checks.join(' AND '), args).then(function (result) { return result['cnt']; });
    };
    return SqlStoreIndex;
}());
