/**
 * SqlProviderBase.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * Abstract helpers for all NoSqlProvider DbProviders that are based on SQL backings.
 */

import _ = require('lodash');

import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import NoSqlProviderUtils = require('./NoSqlProviderUtils');

export abstract class SqlProviderBase extends NoSqlProvider.DbProvider {
    protected _getDbVersion(): SyncTasks.Promise<number> {
        return this.openTransaction('metadata', true).then((trans: SqlTransaction) => {
            // Create table if needed
            return trans.runQuery('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)').then((data) => {
                return trans.runQuery('SELECT value from metadata where name=?', ['schemaVersion']).then(data => {
                    if (data && data[0] && data[0].value) {
                        return Number(data[0].value) || 0;
                    }
                    return 0;
                });
            });
        });
    }

    protected _changeDbVersion(oldVersion: number, newVersion: number): SyncTasks.Promise<SqlTransaction> {
        return this.openTransaction('metadata', true).then((trans: SqlTransaction) => {
            return trans.runQuery('INSERT OR REPLACE into metadata (\'name\', \'value\') VALUES (\'schemaVersion\', ?)', [newVersion])
                .then(() => {
                    return trans;
                });
        });
    }

    protected _ourVersionChecker(wipeIfExists: boolean): SyncTasks.Promise<void> {
        return this._getDbVersion()
            .then(oldVersion => {
                if (oldVersion !== this._schema.version) {
                    // Needs a schema upgrade/change
                    if (!wipeIfExists && this._schema.version < oldVersion) {
                        console.log('Database version too new (' + oldVersion + ') for schema version (' + this._schema.version + '). Wiping!');
                        wipeIfExists = true;
                    }

                    return this._changeDbVersion(oldVersion, this._schema.version).then(trans => {
                        return this._upgradeDb(trans, oldVersion, wipeIfExists);
                    });
                } else if (wipeIfExists) {
                    // No version change, but wipe anyway
                    return this.openTransaction(null, true).then((trans: SqlTransaction) => {
                        return this._upgradeDb(trans, oldVersion, true);
                    });
                }
            });
    }

    protected _upgradeDb(trans: SqlTransaction, oldVersion: number, wipeAnyway: boolean): SyncTasks.Promise<void> {
        // Get a list of all tables and indexes on the tables
        return trans.runQuery('SELECT type, name, tbl_name from sqlite_master', [])
            .then(rows => {
                let tableNames: string[] = [];
                let indexNames: { [table: string]: string[] } = {};
                
                _.each(rows, row => {
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
                if (wipeAnyway || (this._schema.lastUsableVersion && oldVersion < this._schema.lastUsableVersion)) {
                    // Clear all stores if it's past the usable version
                    if (!wipeAnyway) {
                        console.log('Old version detected (' + oldVersion + '), clearing all tables');
                    }

                    dropQueries = _.map(tableNames, name => {
                        trans.runQuery('DROP TABLE ' + name);
                    });

                    tableNames = [];
                } else {
                    // Just delete tables we don't care about anymore.  Only care about the raw data in the tables since we're going to
                    // re-insert all data anyways, so clear out any multiEntry index tables.
                    let tableNamesNeeded: string[] = [];
                    _.each(this._schema.stores, store => {
                        tableNamesNeeded.push(store.name);
                    });
                    dropQueries = _.chain(tableNames).filter(name => !_.includes(tableNamesNeeded, name))
                        .map(name => trans.runQuery('DROP TABLE ' + name)).value();

                    tableNames = _.filter(tableNames, name => _.includes(tableNamesNeeded, name));
                }

                return SyncTasks.all(dropQueries).then(() => {
                    var tableQueries = [];

                    // Go over each store and see what needs changing
                    _.each(this._schema.stores, storeSchema => {
                        var indexMaker = () => {
                            var indexQueries = _.map(storeSchema.indexes, index => {
                                // Go over each index and see if we need to create an index or a table for a multiEntry index
                                if (index.multiEntry) {
                                    if (NoSqlProviderUtils.isCompoundKeyPath(index.keyPath)) {
                                        throw new Error('Can\'t use multiEntry and compound keys');
                                    } else {
                                        return trans.runQuery('CREATE TABLE ' + storeSchema.name + '_' + index.name +
                                            ' (nsp_key TEXT, nsp_refrowid INTEGER)').then(() => {
                                                return trans.runQuery('CREATE ' + (index.unique ? 'UNIQUE ' : '') + 'INDEX ' +
                                                    storeSchema.name + '_' + index.name + '_pi ON ' + storeSchema.name + '_' +
                                                    index.name + ' (nsp_key, nsp_refrowid)');
                                            });
                                    }
                                } else {
                                    return trans.runQuery('CREATE ' + (index.unique ? 'UNIQUE ' : '') + 'INDEX ' + storeSchema.name +
                                        '_' + index.name + ' ON ' + storeSchema.name + ' (nsp_i_' + index.name + ')');
                                }
                            });

                            return SyncTasks.all(indexQueries);
                        };

                        var tableMaker = () => {
                            // Create the table

                            var fieldList = [];

                            fieldList.push('nsp_pk TEXT PRIMARY KEY');

                            fieldList.push('nsp_data TEXT');

                            var nonMultiIndexes = _.filter(storeSchema.indexes || [], index => !index.multiEntry);
                            var indexColumns = _.map(nonMultiIndexes, index => 'nsp_i_' + index.name + ' TEXT');
                            fieldList = fieldList.concat(indexColumns);

                            return trans.runQuery('CREATE TABLE ' + storeSchema.name + ' (' + fieldList.join(', ') + ')')
                                .then(indexMaker);
                        };

                        if (_.includes(tableNames, storeSchema.name)) {
                            // If the table exists, we can't read its schema due to websql security rules,
                            // so just make a copy and fully migrate the data over.

                            // Nuke old indexes on the original table (since they don't change names and we don't need them anymore)
                            let nukeIndexesAndRename = SyncTasks.all(_.map(indexNames[storeSchema.name], indexName =>
                                trans.runQuery('DROP INDEX ' + indexName)
                            )).then(() => {
                                // Then rename the table to a temp_[name] table so we can migrate the data out of it
                                return trans.runQuery('ALTER TABLE ' + storeSchema.name + ' RENAME TO temp_' + storeSchema.name);
                            });

                            // Migrate the data over using our existing put functions (since it will do the right things with the indexes)
                            // and delete the temp table.
                            let migrator = () => {
                                var store = trans.getStore(storeSchema.name);
                                var objs = [];
                                return trans.getResultsFromQueryWithCallback('SELECT nsp_data FROM temp_' + storeSchema.name, null,
                                    (obj) => {
                                        objs.push(obj);
                                    }).then(() => {
                                        return store.put(objs).then(() => {
                                            return trans.runQuery('DROP TABLE temp_' + storeSchema.name);
                                        });
                                    });
                            };

                            tableQueries.push(nukeIndexesAndRename.then(tableMaker).then(migrator));
                        } else {
                            // Table doesn't exist -- just go ahead and create it without the migration path
                            tableQueries.push(tableMaker());
                        }
                    });

                    return SyncTasks.all(tableQueries);
                });
            })
            .then(() => void 0);
    }
}

// The DbTransaction implementation for the WebSQL DbProvider.  All WebSQL accesses go through the transaction
// object, so this class actually has several helpers for executing SQL queries, getting results from them, etc.
export abstract class SqlTransaction implements NoSqlProvider.DbTransaction {
    constructor(
        protected _schema: NoSqlProvider.DbSchema,
        protected _verbose: boolean,
        protected _maxVariables: number) {
    }

    abstract runQuery(sql: string, parameters?: any[]): SyncTasks.Promise<any[]>;

    abstract getResultsFromQueryWithCallback(sql: string, parameters: any[], callback: (obj: any) => void): SyncTasks.Promise<void>;

    getMaxVariables(): number {
        return this._maxVariables;
    }

    nonQuery(sql: string, parameters?: any[]): SyncTasks.Promise<void> {
        return this.runQuery(sql, parameters).then<void>(_.noop);
    }

    getResultsFromQuery<T>(sql: string, parameters?: any[]): SyncTasks.Promise<T[]> {
        return this.runQuery(sql, parameters).then(rows => {
            var rets: T[] = [];
            for (var i = 0; i < rows.length; i++) {
                try {
                    rets.push(JSON.parse(rows[i].nsp_data))
                } catch (e) {
                    return SyncTasks.Rejected('Error parsing database entry in getResultsFromQuery: ' + JSON.stringify(rows[i].nsp_data));
                }
            }
            return rets;
        });
    }

    getResultFromQuery<T>(sql: string, parameters?: any[]): SyncTasks.Promise<T> {
        return this.getResultsFromQuery<T>(sql, parameters)
            .then(rets => rets.length < 1 ? null : rets[0]);
    }

    getStore(storeName: string): NoSqlProvider.DbStore {
        var storeSchema = _.find(this._schema.stores, store => store.name === storeName);
        if (storeSchema === void 0) {
            return null;
        }

        return new SqlStore(this, storeSchema, this._requiresUnicodeReplacement());
    }

    protected _requiresUnicodeReplacement(): boolean {
        return false;
    }
}

// Generic base transaction for anything that matches the syntax of a SQLTransaction interface for executing sql commands.
// Conveniently, this works for both WebSql and cordova's Sqlite plugin.
export class SqliteSqlTransaction extends SqlTransaction {
    private _pendingQueries: SyncTasks.Deferred<any>[] = [];
    
    constructor(private _trans: SQLTransaction,
        schema: NoSqlProvider.DbSchema, verbose: boolean, maxVariables: number) {
        super(schema, verbose, maxVariables);
    }
    
    // If an external provider of the transaction determines that the transaction has failed but won't report its failures 
    // (i.e. in the case of WebSQL), we need a way to kick the hanging queries that they're going to fail since otherwise
    // they'll never respond.
    failAllPendingQueries(error: any) {
        const list = this._pendingQueries;
        this._pendingQueries = [];
        _.each(list, query => {
            query.reject(error);
        });
    }

    runQuery(sql: string, parameters?: any[]): SyncTasks.Promise<any[]> {
        const deferred = SyncTasks.Defer<any[]>();
        this._pendingQueries.push(deferred);

        if (this._verbose) {
            console.log('Query: ' + sql);
        }

        this._trans.executeSql(sql, parameters, (t, rs) => {
            const index = _.indexOf(this._pendingQueries, deferred);
            if (index !== -1) {
                var rows = [];
                for (var i = 0; i < rs.rows.length; i++) {
                    rows.push(rs.rows.item(i));
                }
                this._pendingQueries.splice(index, 1);
                deferred.resolve(rows);
            } else {
                console.error('SQL statement resolved twice (success this time): ' + sql);
            }
        }, (t, err) => {
            if (!err) {
                // The cordova-native-sqlite-storage plugin only passes a single parameter here, the error, slightly breaking the interface.
                err = t as any;
            }

            console.log('Query Error: SQL: ' + sql + ', Error: ' + err.message);

            const index = _.indexOf(this._pendingQueries, deferred);
            if (index !== -1) {
                this._pendingQueries.splice(index, 1);
                deferred.reject(err);
            } else {
                console.error('SQL statement resolved twice (this time with failure)');
            }
        });

        return deferred.promise();
    }

    getResultsFromQueryWithCallback(sql: string, parameters: any[], callback: (obj: any) => void): SyncTasks.Promise<void> {
        const deferred = SyncTasks.Defer<void>();

        if (this._verbose) {
            console.log('Query: ' + sql);
        }

        this._trans.executeSql(sql, parameters, (t, rs) => {
            for (var i = 0; i < rs.rows.length; i++) {
                const item = rs.rows.item(i).nsp_data;
                let ret: any;
                try {
                    ret = JSON.parse(item);
                } catch (e) {
                    deferred.reject('Error parsing database entry in getResultsFromQueryWithCallback: ' + JSON.stringify(item));
                    return;
                }
                try {
                    callback(ret);
                } catch (e) {
                    deferred.reject('Exception in callback in getResultsFromQueryWithCallback: ' + JSON.stringify(e));
                    return;
                }
            }
            deferred.resolve();
        }, (t, err) => {
            console.log('Query Error: SQL: ' + sql + ', Error: ' + err.message);
            deferred.reject(err);
        });

        return deferred.promise();
    }
}

// DbStore implementation for the SQL-based DbProviders.  Implements the getters/setters against the transaction object and all of the
// glue for index/compound key support.
class SqlStore implements NoSqlProvider.DbStore {
    private _trans: SqlTransaction;
    private _schema: NoSqlProvider.StoreSchema;
    private _replaceUnicode: boolean;

    constructor(trans: SqlTransaction, schema: NoSqlProvider.StoreSchema, replaceUnicode: boolean) {
        this._trans = trans;
        this._schema = schema;
        this._replaceUnicode = replaceUnicode;
    }

    get<T>(key: any | any[]): SyncTasks.Promise<T> {
        let joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath);
        return this._trans.getResultFromQuery<T>('SELECT nsp_data FROM ' + this._schema.name + ' WHERE nsp_pk = ?', [joinedKey]);
    }

    getMultiple<T>(keyOrKeys: any | any[]): SyncTasks.Promise<T[]> {
        let joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);

        if (joinedKeys.length === 0) {
            return SyncTasks.Resolved<T[]>([]);
        }

        var qmarks: string[] = Array(joinedKeys.length);
        for (let i = 0; i < joinedKeys.length; i++) {
            qmarks[i] = '?';
        }

        return this._trans.getResultsFromQuery<T>('SELECT nsp_data FROM ' + this._schema.name + ' WHERE nsp_pk IN (' +
            qmarks.join(',') + ')', joinedKeys);
    }

    private static _unicodeFixer = new RegExp('[\u2028\u2029]', 'g');

    put(itemOrItems: any | any[]): SyncTasks.Promise<void> {
        // TODO dadere (#333864): Change to a multi-insert single query, but make sure to take the multiEntry madness into account

        let items = NoSqlProviderUtils.arrayify(itemOrItems);

        if (items.length === 0) {
            return SyncTasks.Resolved<void>();
        }

        var fields: string[] = ['nsp_pk', 'nsp_data'];
        var qmarks: string[] = ['?', '?'];
        var args: any[] = [];

        _.each(this._schema.indexes, index => {
            if (!index.multiEntry) {
                qmarks.push('?');
                fields.push('nsp_i_' + index.name);
            }
        });

        const qmarkString = qmarks.join(',');
        _.each(<any[]>items, (item) => {
            let serializedData = JSON.stringify(item);
            // For now, until an issue with cordova-ios is fixed (https://issues.apache.org/jira/browse/CB-9435), have to replace
            // \u2028 and 2029 with blanks because otherwise the command boundary with cordova-ios silently eats any strings with them.
            if (this._replaceUnicode) {
                serializedData = serializedData.replace(SqlStore._unicodeFixer, '');
            }
            args.push(NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._schema.primaryKeyPath), serializedData);

            _.each(this._schema.indexes, index => {
                if (!index.multiEntry) {
                    args.push(NoSqlProviderUtils.getSerializedKeyForKeypath(item, index.keyPath));
                }
            });
        });

        // Need to not use too many variables per insert, so batch the insert if needed.
        let inserts: SyncTasks.Promise<void>[] = [];
        const itemPageSize = Math.floor(this._trans.getMaxVariables() / fields.length);
        for (let i = 0; i < items.length; i += itemPageSize) {
            const thisPageCount = Math.min(itemPageSize, items.length - i);
            const qmarksValues = _.fill(new Array(thisPageCount), qmarkString);
            inserts.push(this._trans.nonQuery('INSERT OR REPLACE INTO ' + this._schema.name + ' (' + fields.join(',') + ') VALUES (' +
                qmarksValues.join('),(') + ')', args.splice(0, thisPageCount*fields.length)));
        }

        return SyncTasks.all(inserts).then(() => {
                if (_.some(this._schema.indexes, index => index.multiEntry)) {
                    let queries: SyncTasks.Promise<void>[] = [];

                    _.each(items, item => {
                        queries.push(this._trans.runQuery('SELECT rowid a FROM ' + this._schema.name + ' WHERE nsp_pk = ?',
                            [NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._schema.primaryKeyPath)])
                            .then(rets => {
                                let rowid = rets[0].a;

                                let inserts = _.chain(this._schema.indexes).filter(index => index.multiEntry).map(index => {
                                    // Have to extract the multiple entries into the alternate table...

                                    const valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, <string>index.keyPath);
                                    const serializedKeys = _.map(NoSqlProviderUtils.arrayify(valsRaw), val =>
                                        NoSqlProviderUtils.serializeKeyToString(val, <string>index.keyPath));

                                    let valArgs = [], args = [];
                                    _.each(serializedKeys, val => {
                                        valArgs.push('(?, ?)');
                                        args.push(val);
                                        args.push(rowid);
                                    });
                                    return this._trans.nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name +
                                        ' WHERE nsp_refrowid = ?', [rowid]).then(() => {
                                            this._trans.nonQuery('INSERT INTO ' + this._schema.name + '_' + index.name +
                                                ' (nsp_key, nsp_refrowid) VALUES ' + valArgs.join(','), args);
                                        });
                                }).value();
                                return SyncTasks.all(inserts).then(rets => void 0);
                            }));
                    });

                    return SyncTasks.all(queries).then(rets => void 0);
                }
            });
    }

    remove(keyOrKeys: any | any[]): SyncTasks.Promise<void> {
        let joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);

        // PERF: This is optimizable, but it's of questionable utility
        var queries = _.map(joinedKeys, joinedKey => {
            if (_.some(this._schema.indexes, index => index.multiEntry)) {
                // If there's any multientry indexes, we have to do the more complicated version...
                return this._trans.runQuery('SELECT rowid a FROM ' + this._schema.name + ' WHERE nsp_pk = ?', [joinedKey]).then(rets => {
                    if (rets.length === 0) {
                        return null;
                    }

                    var queries = _.chain(this._schema.indexes).filter(index => index.multiEntry).map(index =>
                        this._trans.nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name +
                            ' WHERE nsp_refrowid = ?', [rets[0].a])).value();
                    queries.push(this._trans.nonQuery('DELETE FROM ' + this._schema.name + ' WHERE rowid = ?', [rets[0].a]));
                    return SyncTasks.all(queries).then(_.noop);
                });
            }

            return this._trans.nonQuery('DELETE FROM ' + this._schema.name + ' WHERE nsp_pk = ?', [joinedKey]);
        });

        return SyncTasks.all(queries).then(rets => void 0);
    }

    openIndex(indexName: string): NoSqlProvider.DbIndex {
        var indexSchema = _.find(this._schema.indexes, index => index.name === indexName);
        if (indexSchema === void 0) {
            return null;
        }

        return new SqlStoreIndex(this._trans, this._schema, indexSchema);
    }

    openPrimaryKey(): NoSqlProvider.DbIndex {
        return new SqlStoreIndex(this._trans, this._schema, null);
    }

    clearAllData(): SyncTasks.Promise<void> {
        var queries = _.chain(this._schema.indexes).filter(index => index.multiEntry).map(index =>
            this._trans.nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name)).value();

        queries.push(this._trans.nonQuery('DELETE FROM ' + this._schema.name));

        return SyncTasks.all(queries).then(rets => void 0);
    }
}

// DbIndex implementation for SQL-based DbProviders.  Wraps all of the nasty compound key logic and general index traversal logic into
// the appropriate SQL queries.
class SqlStoreIndex implements NoSqlProvider.DbIndex {
    private _trans: SqlTransaction;
    private _queryColumn: string;
    private _tableName: string;
    private _keyPath: string | string[];

    constructor(trans: SqlTransaction, storeSchema: NoSqlProvider.StoreSchema, indexSchema: NoSqlProvider.IndexSchema) {
        this._trans = trans;

        if (!indexSchema) {
            // Going against the PK of the store
            this._tableName = storeSchema.name;
            this._queryColumn = 'nsp_pk';
            this._keyPath = storeSchema.primaryKeyPath;
        } else {
            if (indexSchema.multiEntry) {
                this._tableName = storeSchema.name + '_' + indexSchema.name + ' mi LEFT JOIN ' + storeSchema.name +
                ' ON mi.nsp_refrowid = ' + storeSchema.name + '.rowid';
                this._queryColumn = 'mi.nsp_key';
            } else {
                this._tableName = storeSchema.name;
                this._queryColumn = 'nsp_i_' + indexSchema.name;
            }
            this._keyPath = indexSchema.keyPath;
        }
    }

    private _handleQuery<T>(sql: string, args: any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        sql += ' ORDER BY ' + this._queryColumn + (reverse ? ' DESC' : ' ASC');

        if (limit) {
            sql += ' LIMIT ' + limit.toString();
        }
        if (offset) {
            sql += ' OFFSET ' + offset.toString();
        }

        return this._trans.getResultsFromQuery<T>(sql, args);
    }

    getAll<T>(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        return this._handleQuery<T>('SELECT nsp_data FROM ' + this._tableName, null, reverse, limit, offset);
    }

    getOnly<T>(key: any | any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        let joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._keyPath);

        return this._handleQuery<T>('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + this._queryColumn + ' = ?', [joinedKey],
            reverse, limit, offset);
    }

    getRange<T>(keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        const { checks, args } = this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        return this._handleQuery<T>('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + checks.join(' AND '), args, reverse, limit,
            offset);
    }

    private _getRangeChecks(keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean) {
        let checks: string[] = [];
        let args: string[] = [];
        if (keyLowRange !== null && keyLowRange !== void 0) {
            checks.push(this._queryColumn + (lowRangeExclusive ? ' > ' : ' >= ') + '?');
            args.push(NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath));
        }
        if (keyHighRange !== null && keyHighRange !== void 0) {
            checks.push(this._queryColumn + (highRangeExclusive ? ' < ' : ' <= ') + '?');
            args.push(NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath));
        }
        return { checks, args };
    }

    countAll(): SyncTasks.Promise<number> {
        return this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName).then(result => result[0]['cnt']);
    }

    countOnly(key: any|any[]): SyncTasks.Promise<number> {
        let joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._keyPath);

        return this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName + ' WHERE ' + this._queryColumn 
            + ' = ?', [joinedKey]).then(result => result[0]['cnt']);
    }

    countRange(keyLowRange: any|any[], keyHighRange: any|any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
            : SyncTasks.Promise<number> {
        const { checks, args } = this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        return this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName + ' WHERE ' + checks.join(' AND '),
            args).then(result => result[0]['cnt']);
    }
}
