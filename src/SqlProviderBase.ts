/**
 * SqlProviderBase.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * Abstract helpers for all NoSqlProvider DbProviders that are based on SQL backings.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import FullTextSearchHelpers = require('./FullTextSearchHelpers');
import NoSqlProvider = require('./NoSqlProvider');
import { ItemType } from './NoSqlProvider';
import NoSqlProviderUtils = require('./NoSqlProviderUtils');

// Extending interfaces that should be in lib.d.ts but aren't for some reason.
export interface SQLVoidCallback {
    (): void;
}

export interface SQLTransactionCallback {
    (transaction: SQLTransaction): void;
}

export interface SQLTransactionErrorCallback {
    (error: SQLError): void;
}

export interface SQLDatabase {
    version: string;

    changeVersion(oldVersion: string, newVersion: string, callback?: SQLTransactionCallback,
        errorCallback?: SQLTransactionErrorCallback, successCallback?: SQLVoidCallback): void;
    transaction(callback?: SQLTransactionCallback, errorCallback?: SQLTransactionErrorCallback,
        successCallback?: SQLVoidCallback): void;
    readTransaction(callback?: SQLTransactionCallback, errorCallback?: SQLTransactionErrorCallback,
        successCallback?: SQLVoidCallback): void;
}

const schemaVersionKey = 'schemaVersion';

// This was taked from the sqlite documentation
const SQLITE_MAX_SQL_LENGTH_IN_BYTES = 1000000;

const DB_SIZE_ESIMATE_DEFAULT = 200;
const DB_MIGRATION_MAX_BYTE_TARGET = 1000000;

interface IndexMetadata {
    key: string;
    storeName: string;
    index: NoSqlProvider.IndexSchema;
}

function getIndexIdentifier(storeSchema: NoSqlProvider.StoreSchema, index: NoSqlProvider.IndexSchema): string {
    return storeSchema.name + '_' + index.name;
}

// Certain indexes use a separate table for pivot:
// * Multientry indexes
// * Full-text indexes that support FTS3
function indexUsesSeparateTable(indexSchema: NoSqlProvider.IndexSchema, supportsFTS3: boolean): boolean {
    return indexSchema.multiEntry || (!!indexSchema.fullText && supportsFTS3);
}

const FakeFTSJoinToken = '^$^';

// Limit LIMIT numbers to a reasonable size to not break queries.
const LimitMax = Math.pow(2, 32);

export abstract class SqlProviderBase extends NoSqlProvider.DbProvider {
    constructor(protected _supportsFTS3: boolean) {
        super();
        // NOP
    }

    abstract openTransaction(storeNames: string[]|undefined, writeNeeded: boolean): SyncTasks.Promise<SqlTransaction>;

    private _getMetadata(trans: SqlTransaction): SyncTasks.Promise<{ name: string; value: string; }[]> {
        // Create table if needed
        return trans.runQuery('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)').then(() => {
            return trans.runQuery('SELECT name, value from metadata', []);
        });
    }

    private _storeIndexMetadata(trans: SqlTransaction, meta: IndexMetadata) {
        return trans.runQuery('INSERT OR REPLACE into metadata (\'name\', \'value\') VALUES' +
            '(\'' + meta.key + '\', ?)', [JSON.stringify(meta)]);
    }

    private _getDbVersion(): SyncTasks.Promise<number> {
        return this.openTransaction(undefined, true).then(trans => {
              // Create table if needed
            return trans.runQuery('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)').then(() => {
                return trans.runQuery('SELECT value from metadata where name=?', [schemaVersionKey]).then(data => {
                    if (data && data[0] && data[0].value) {
                        return Number(data[0].value) || 0;
                    }
                    return 0;
                });
            });
        });
    }

    protected _changeDbVersion(oldVersion: number, newVersion: number): SyncTasks.Promise<SqlTransaction> {
        return this.openTransaction(undefined, true).then(trans => {
            return trans.runQuery('INSERT OR REPLACE into metadata (\'name\', \'value\') VALUES (\'' + schemaVersionKey + '\', ?)',
                [newVersion])
                .then(() => trans);
        });
    }

    protected _ourVersionChecker(wipeIfExists: boolean): SyncTasks.Promise<void> {
        return this._getDbVersion()
            .then(oldVersion => {
                if (oldVersion !== this._schema!!!.version) {
                    // Needs a schema upgrade/change
                    if (!wipeIfExists && this._schema!!!.version < oldVersion) {
                        console.log('Database version too new (' + oldVersion + ') for schema version (' + this._schema!!!.version +
                             '). Wiping!');
                        wipeIfExists = true;
                    }

                    return this._changeDbVersion(oldVersion, this._schema!!!.version).then(trans => {
                        return this._upgradeDb(trans, oldVersion, wipeIfExists);
                    });
                } else if (wipeIfExists) {
                    // No version change, but wipe anyway
                    return this.openTransaction(undefined, true).then(trans => {
                        return this._upgradeDb(trans, oldVersion, true);
                    });
                }
                return undefined;
            });
    }

    protected _upgradeDb(trans: SqlTransaction, oldVersion: number, wipeAnyway: boolean): SyncTasks.Promise<void> {
        // Get a list of all tables, columns and indexes on the tables
        return this._getMetadata(trans).then(fullMeta => {
            // Get Index metadatas
            let indexMetadata: IndexMetadata[] =
                _.map(fullMeta, meta => {
                    const metaObj = _.attempt(() => {
                        return JSON.parse(meta.value);
                    });
                    if (_.isError(metaObj)) {
                        return undefined;
                    }
                    return metaObj;
                })
                .filter(meta => !!meta && !!meta.storeName);

            return trans.runQuery('SELECT type, name, tbl_name, sql from sqlite_master', [])
                .then(rows => {
                    let tableNames: string[] = [];
                    let indexNames: { [table: string]: string[] } = {};
                    let indexTables: { [table: string]: string[] } = {};
                    let tableSqlStatements: { [table: string]: string } = {};

                    _.each(rows, row => {
                        const tableName = row['tbl_name'];
                        // Ignore browser metadata tables for websql support
                        if (tableName === '__WebKitDatabaseInfoTable__' || tableName === 'metadata') {
                            return;
                        }
                        // Ignore FTS-generated side tables
                        const endsIn = (str: string, checkstr: string) => {
                            const i = str.indexOf(checkstr);
                            return i !== -1 && i === str.length - checkstr.length;
                        };
                        if (endsIn(tableName, '_content') || endsIn(tableName, '_segments') || endsIn(tableName, '_segdir')) {
                            return;
                        }
                        if (row['type'] === 'table') {
                            tableNames.push(row['name']);
                            tableSqlStatements[row['name']] = row['sql'];
                            const nameSplit = row['name'].split('_');
                            if (nameSplit.length === 1) {
                                if (!indexNames[row['name']]) {
                                    indexNames[row['name']] = [];
                                }
                                if (!indexTables[row['name']]) {
                                    indexTables[row['name']] = [];
                                }
                            } else {
                                const tableName = nameSplit[0];
                                if (indexTables[tableName]) {
                                    indexTables[tableName].push(nameSplit[1]);
                                } else {
                                    indexTables[tableName] = [nameSplit[1]];
                                }
                            }
                        }
                        if (row['type'] === 'index') {
                            if (row['name'].substring(0, 17) === 'sqlite_autoindex_') {
                                // auto-index, ignore
                                return;
                            }
                            if (!indexNames[tableName]) {
                                indexNames[tableName] = [];
                            }
                            indexNames[tableName].push(row['name']);
                        }
                    });

                    const deleteFromMeta = (metasToDelete: IndexMetadata[]) => {
                        if (metasToDelete.length === 0) {
                            return SyncTasks.Resolved([]);
                        }

                        // Generate as many '?' as there are params
                        let placeholder = '?';
                        for (let i = 1; i < metasToDelete.length; i++) {
                            placeholder += ',?';
                        }

                        return trans.runQuery('DELETE FROM metadata WHERE name IN (' + placeholder + ')',
                            _.map(metasToDelete, meta => meta.key));
                    };

                    // Check each table!
                    let dropQueries: SyncTasks.Promise<any>[] = [];
                    if (wipeAnyway || (this._schema!!!.lastUsableVersion && oldVersion < this._schema!!!.lastUsableVersion!!!)) {
                        // Clear all stores if it's past the usable version
                        if (!wipeAnyway) {
                            console.log('Old version detected (' + oldVersion + '), clearing all tables');
                        }

                        dropQueries = _.map(tableNames, name => trans.runQuery('DROP TABLE ' + name));

                        if (indexMetadata.length > 0) {
                            // Drop all existing metadata
                            dropQueries.push(deleteFromMeta(indexMetadata));
                            indexMetadata = [];
                        }
                        tableNames = [];
                    } else {
                        // Just delete tables we don't care about anymore. Preserve multi-entry tables, they may not be changed
                        let tableNamesNeeded: string[] = [];
                        _.each(this._schema!!!.stores, store => {
                            tableNamesNeeded.push(store.name);
                            _.each(store.indexes, index => {
                                if (indexUsesSeparateTable(index, this._supportsFTS3)) {
                                    tableNamesNeeded.push(getIndexIdentifier(store, index));
                                }
                            });
                        });
                        let tableNamesNotNeeded = _.filter(tableNames, name => !_.includes(tableNamesNeeded, name));
                        dropQueries = _.flatten(_.map(tableNamesNotNeeded, name => {
                            const transList: SyncTasks.Promise<any>[] = [trans.runQuery('DROP TABLE ' + name)];
                            const metasToDelete = _.filter(indexMetadata, meta => meta.storeName === name);
                            const metaKeysToDelete = _.map(metasToDelete, meta => meta.key);

                            // Clean up metas
                            if (metasToDelete.length > 0) {
                                transList.push(deleteFromMeta(metasToDelete));
                                indexMetadata = _.filter(indexMetadata, meta => !_.includes(metaKeysToDelete, meta.key));
                            }
                            return transList;
                        }));

                        tableNames = _.filter(tableNames, name => _.includes(tableNamesNeeded, name));
                    }

                    const tableColumns: { [table: string]: string[] } = {};

                    const getColumnNames = (tableName: string): string[] => {
                        // Try to get all the column names from SQL create statement
                        const r = /CREATE\s+TABLE\s+\w+\s+\(([^\)]+)\)/;
                        const columnPart = tableSqlStatements[tableName].match(r);
                        if (columnPart) {
                            return columnPart[1].split(',').map(p => p.trim().split(/\s+/)[0]);
                        }
                        return [];
                    };

                    _.each(tableNames, table => {
                        tableColumns[table] = getColumnNames(table);
                    });

                    return SyncTasks.all(dropQueries).then(() => {

                        let tableQueries: SyncTasks.Promise<any>[] = [];

                        // Go over each store and see what needs changing
                        _.each(this._schema!!!.stores, storeSchema => {

                            // creates indexes for provided schemas 
                            const indexMaker = (indexes: NoSqlProvider.IndexSchema[] = []) => {
                                let metaQueries: SyncTasks.Promise<any>[] = [];
                                const indexQueries = _.map(indexes, index => {
                                    const indexIdentifier = getIndexIdentifier(storeSchema, index);

                                    // Store meta for the index
                                    const newMeta: IndexMetadata = {
                                        key: indexIdentifier,
                                        storeName: storeSchema.name,
                                        index: index
                                    };
                                    metaQueries.push(this._storeIndexMetadata(trans, newMeta));
                                    // Go over each index and see if we need to create an index or a table for a multiEntry index
                                    if (index.multiEntry) {
                                        if (NoSqlProviderUtils.isCompoundKeyPath(index.keyPath)) {
                                            return SyncTasks.Rejected('Can\'t use multiEntry and compound keys');
                                        } else {
                                            return trans.runQuery('CREATE TABLE IF NOT EXISTS ' + indexIdentifier +
                                                ' (nsp_key TEXT, nsp_refpk TEXT' +
                                                (index.includeDataInIndex ? ', nsp_data TEXT' : '') + ')').then(() => {
                                                    return trans.runQuery('CREATE ' + (index.unique ? 'UNIQUE ' : '') + 
                                                        'INDEX IF NOT EXISTS ' +
                                                        indexIdentifier + '_pi ON ' + indexIdentifier + ' (nsp_key, nsp_refpk' +
                                                        (index.includeDataInIndex ? ', nsp_data' : '') + ')');
                                                });
                                        }
                                    } else if (index.fullText && this._supportsFTS3) {
                                        // If FTS3 isn't supported, we'll make a normal column and use LIKE to seek over it, so the
                                        // fallback below works fine.
                                        return trans.runQuery('CREATE VIRTUAL TABLE IF NOT EXISTS ' + indexIdentifier +
                                            ' USING FTS3(nsp_key TEXT, nsp_refpk TEXT)');
                                    } else {
                                        return trans.runQuery('CREATE ' + (index.unique ? 'UNIQUE ' : '') +
                                            'INDEX IF NOT EXISTS ' + indexIdentifier +
                                            ' ON ' + storeSchema.name + ' (nsp_i_' + index.name +
                                            (index.includeDataInIndex ? ', nsp_data' : '') + ')');
                                    }
                                });

                                return SyncTasks.all(indexQueries.concat(metaQueries));
                            };

                            // Form SQL statement for table creation
                            let fieldList = [];

                            fieldList.push('nsp_pk TEXT PRIMARY KEY');
                            fieldList.push('nsp_data TEXT');

                            const columnBasedIndices = _.filter(storeSchema.indexes, index =>
                                !indexUsesSeparateTable(index, this._supportsFTS3));

                            const indexColumnsNames = _.map(columnBasedIndices, index => 'nsp_i_' + index.name + ' TEXT');
                            fieldList = fieldList.concat(indexColumnsNames);
                            const tableMakerSql = 'CREATE TABLE ' + storeSchema.name + ' (' + fieldList.join(', ') + ')';
                            
                            const currentIndexMetas = _.filter(indexMetadata, meta => meta.storeName === storeSchema.name);
                            
                            const indexIdentifierDictionary = _.keyBy(storeSchema.indexes, index => getIndexIdentifier(storeSchema, index));
                            const indexMetaDictionary = _.keyBy(currentIndexMetas, meta => meta.key);

                            // find which indices in the schema existed / did not exist before
                            const [newIndices, existingIndices] = _.partition(storeSchema.indexes, index =>
                                !indexMetaDictionary[getIndexIdentifier(storeSchema, index)]);

                            const existingIndexColumns = _.intersection(existingIndices, columnBasedIndices);

                            // find indices in the meta that do not exist in the new schema
                            const allRemovedIndexMetas = _.filter(currentIndexMetas, meta => 
                                !indexIdentifierDictionary[meta.key]);

                            const [removedTableIndexMetas, removedColumnIndexMetas] = _.partition(allRemovedIndexMetas, 
                                meta => indexUsesSeparateTable(meta.index, this._supportsFTS3));

                            // find new indices which don't require backfill
                            const newNoBackfillIndices = _.filter(newIndices, index => {
                                return !!index.doNotBackfill;
                            });

                            // columns requiring no backfill could be simply added to the table
                            const newIndexColumnsNoBackfill = _.intersection(newNoBackfillIndices, columnBasedIndices);

                            const columnAdder = () => {
                                const addQueries = _.map(newIndexColumnsNoBackfill, index => 
                                    trans.runQuery('ALTER TABLE ' + storeSchema.name + ' ADD COLUMN ' + 'nsp_i_' + index.name + ' TEXT')
                                );

                                return SyncTasks.all(addQueries);
                            };

                            const tableMaker = () => {
                                // Create the table
                                return trans.runQuery(tableMakerSql)
                                    .then(() => indexMaker(storeSchema.indexes));
                            };

                            const columnExists = (tableName: string, columnName: string) => {
                                return _.includes(tableColumns[tableName], columnName);
                            };

                            const needsFullMigration = () => {
                                // Check all the indices in the schema
                                return _.some(storeSchema.indexes, index => {
                                    const indexIdentifier = getIndexIdentifier(storeSchema, index);
                                    const indexMeta = indexMetaDictionary[indexIdentifier];
                                    
                                    // if there's a new index that doesn't require backfill, continue
                                    // If there's a new index that requires backfill - we need to migrate 
                                    if (!indexMeta) {
                                        return !index.doNotBackfill;
                                    }

                                    // If the index schemas don't match - we need to migrate
                                    if (!_.isEqual(indexMeta.index, index)) {
                                        return true;    
                                    }

                                    // Check that indicies actually exist in the right place
                                    if (indexUsesSeparateTable(index, this._supportsFTS3)) {
                                        if (!_.includes(tableNames, indexIdentifier)) {
                                            return true;
                                        }
                                    } else {
                                        if (!columnExists(storeSchema.name, 'nsp_i_' + index.name)) {
                                            return true;
                                        }
                                    }

                                    return false;
                                });
                            };

                            const dropColumnIndices = () => {
                                return _.map(indexNames[storeSchema.name], indexName =>
                                    trans.runQuery('DROP INDEX ' + indexName));
                            };

                            const dropIndexTables = (tableNames: string[]) => {
                                return _.map(tableNames, tableName => 
                                    trans.runQuery('DROP TABLE IF EXISTS ' + storeSchema.name + '_' + tableName)
                                );
                            };

                            const createTempTable = () => {
                                // Then rename the table to a temp_[name] table so we can migrate the data out of it
                                return trans.runQuery('ALTER TABLE ' + storeSchema.name + ' RENAME TO temp_' + storeSchema.name);
                            };

                            const dropTempTable = () => {
                                return trans.runQuery('DROP TABLE temp_' + storeSchema.name);
                            };

                            // find is there are some columns that should be, but are not indices
                            // this is to fix a mismatch between the schema in metadata and the actual table state
                            const someIndicesMissing = _.some(columnBasedIndices, index => 
                                columnExists(storeSchema.name, 'nsp_i_' + index.name) 
                                    && !_.includes(indexNames[storeSchema.name], getIndexIdentifier(storeSchema, index))
                            );

                            // If the table exists, check if we can to determine if a migration is needed
                            // If a full migration is needed, we have to copy all the data over and re-populate indices
                            // If a in-place migration is enough, we can just copy the data
                            // If no migration is needed, we can just add new column for new indices
                            const tableExists = _.includes(tableNames, storeSchema.name);
                            const doFullMigration = tableExists && needsFullMigration();
                            const doSqlInPlaceMigration = tableExists && !doFullMigration && removedColumnIndexMetas.length > 0;
                            const adddNewColumns = tableExists && !doFullMigration && !doSqlInPlaceMigration 
                                && newNoBackfillIndices.length > 0;
                            const recreateIndices = tableExists && !doFullMigration && !doSqlInPlaceMigration && someIndicesMissing;

                            const indexFixer = () => {
                                if (recreateIndices) {
                                    return indexMaker(storeSchema.indexes);
                                }
                                return SyncTasks.Resolved([]);
                            };

                            const indexTableAndMetaDropper = () => {
                                const indexTablesToDrop = doFullMigration 
                                    ? indexTables[storeSchema.name] : removedTableIndexMetas.map(meta => meta.key);
                                return SyncTasks.all([deleteFromMeta(allRemovedIndexMetas), ...dropIndexTables(indexTablesToDrop)]);
                            };

                            if (!tableExists) {
                                // Table doesn't exist -- just go ahead and create it without the migration path
                                tableQueries.push(tableMaker());
                            } 
                            
                            if (doFullMigration) {
                                // Migrate the data over using our existing put functions
                                // (since it will do the right things with the indexes)
                                // and delete the temp table.
                                const jsMigrator = (batchOffset = 0): SyncTasks.Promise<any> => {
                                    let esimatedSize = storeSchema.estimatedObjBytes || DB_SIZE_ESIMATE_DEFAULT;
                                    let batchSize = Math.max(1, Math.floor(DB_MIGRATION_MAX_BYTE_TARGET / esimatedSize));
                                    let store = trans.getStore(storeSchema.name);
                                    return trans.internal_getResultsFromQuery('SELECT nsp_data FROM temp_' + storeSchema.name + ' LIMIT ' +
                                            batchSize + ' OFFSET ' + batchOffset)
                                        .then(objs => {
                                            return store.put(objs).then(() => {
                                                // Are we done migrating?
                                                if (objs.length < batchSize) {
                                                    return undefined;
                                                }
                                                return jsMigrator(batchOffset + batchSize);
                                            });
                                    });
                                };

                                tableQueries.push(
                                    SyncTasks.all([
                                        indexTableAndMetaDropper(),
                                        dropColumnIndices(),
                                    ])
                                    .then(createTempTable)
                                    .then(tableMaker)
                                    .then(() => {
                                        return jsMigrator();
                                    })
                                    .then(dropTempTable)
                                );
                            } 
                            
                            if (doSqlInPlaceMigration) {
                                const sqlInPlaceMigrator = () => {
                                    const columnsToCopy = ['nsp_pk', 'nsp_data',  
                                        ..._.map(existingIndexColumns, index => 'nsp_i_' + index.name)
                                    ].join(', ');

                                    return trans.runQuery('INSERT INTO ' + storeSchema.name + ' (' + columnsToCopy + ')' +
                                        ' SELECT ' + columnsToCopy + 
                                        ' FROM temp_' + storeSchema.name);
                                };

                                tableQueries.push(
                                    SyncTasks.all([
                                        indexTableAndMetaDropper(),
                                        dropColumnIndices(),
                                    ])
                                    .then(createTempTable)
                                    .then(tableMaker)
                                    .then(sqlInPlaceMigrator)
                                    .then(dropTempTable)
                                );

                            }
                            
                            if (adddNewColumns) {
                                const newIndexMaker = () => indexMaker(newNoBackfillIndices);

                                tableQueries.push(
                                    indexTableAndMetaDropper(),
                                    columnAdder()
                                        .then(newIndexMaker)
                                        .then(indexFixer)
                                );
                            } else if (recreateIndices) {
                                tableQueries.push(indexFixer());
                            }

                        });

                        return SyncTasks.all(tableQueries);
                    });
                });
        }).then(_.noop);
    }
}

// The DbTransaction implementation for the WebSQL DbProvider.  All WebSQL accesses go through the transaction
// object, so this class actually has several helpers for executing SQL queries, getting results from them, etc.
export abstract class SqlTransaction implements NoSqlProvider.DbTransaction {
    private _isOpen = true;

    constructor(
            protected _schema: NoSqlProvider.DbSchema,
            protected _verbose: boolean,
            protected _maxVariables: number,
            private _supportsFTS3: boolean) {
        if (this._verbose) {
            console.log('Opening Transaction');
        }
    }

    protected _isTransactionOpen(): boolean {
        return this._isOpen;
    }

    internal_markTransactionClosed(): void {
        if (this._verbose) {
            console.log('Marking Transaction Closed');
        }
        this._isOpen = false;
    }

    abstract getCompletionPromise(): SyncTasks.Promise<void>;
    abstract abort(): void;

    abstract runQuery(sql: string, parameters?: any[]): SyncTasks.Promise<any[]>;

    internal_getMaxVariables(): number {
        return this._maxVariables;
    }

    internal_nonQuery(sql: string, parameters?: any[]): SyncTasks.Promise<void> {
        return this.runQuery(sql, parameters).then<void>(_.noop);
    }

    internal_getResultsFromQuery<T>(sql: string, parameters?: any[]): SyncTasks.Promise<T[]> {
        return this.runQuery(sql, parameters).then(rows => {
            let rets: T[] = [];
            for (let i = 0; i < rows.length; i++) {
                try {
                    rets.push(JSON.parse(rows[i].nsp_data));
                } catch (e) {
                    return SyncTasks.Rejected('Error parsing database entry in getResultsFromQuery: ' + JSON.stringify(rows[i].nsp_data));
                }
            }
            return rets;
        });
    }

    internal_getResultFromQuery<T>(sql: string, parameters?: any[]): SyncTasks.Promise<T|undefined> {
        return this.internal_getResultsFromQuery<T>(sql, parameters)
            .then(rets => rets.length < 1 ? undefined : rets[0]);
    }

    getStore(storeName: string): NoSqlProvider.DbStore {
        const storeSchema = _.find(this._schema.stores, store => store.name === storeName);
        if (!storeSchema) {
            throw new Error('Store not found: ' + storeName);
        }

        return new SqlStore(this, storeSchema, this._requiresUnicodeReplacement(), this._supportsFTS3, this._verbose);
    }

    markCompleted(): void {
        // noop
    }

    protected _requiresUnicodeReplacement(): boolean {
        return false;
    }
}

export interface SQLError {
    code: number;
    message: string;
}

export interface SQLResultSet {
    insertId: number;
    rowsAffected: number;
    rows: SQLResultSetRowList;
}

export interface SQLResultSetRowList {
    length: number;
    item(index: number): any;
}

export interface SQLStatementCallback {
    (transaction: SQLTransaction, resultSet: SQLResultSet): void;
}

export interface SQLStatementErrorCallback {
    (transaction: SQLTransaction, error: SQLError): void;
}

export interface SQLTransaction {
    executeSql(sqlStatement: string, args?: any[], callback?: SQLStatementCallback, errorCallback?: SQLStatementErrorCallback): void;
}

// Generic base transaction for anything that matches the syntax of a SQLTransaction interface for executing sql commands.
// Conveniently, this works for both WebSql and cordova's Sqlite plugin.
export abstract class SqliteSqlTransaction extends SqlTransaction {
    private _pendingQueries: SyncTasks.Deferred<any>[] = [];

    constructor(protected _trans: SQLTransaction, schema: NoSqlProvider.DbSchema, verbose: boolean, maxVariables: number,
            supportsFTS3: boolean) {
        super(schema, verbose, maxVariables, supportsFTS3);
    }

    abstract getErrorHandlerReturnValue(): boolean;    

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
        if (!this._isTransactionOpen()) {
            return SyncTasks.Rejected('SqliteSqlTransaction already closed');
        }

        const deferred = SyncTasks.Defer<any[]>();
        this._pendingQueries.push(deferred);

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        const errRet = _.attempt(() => {
            this._trans.executeSql(sql, parameters, (t, rs) => {
                const index = _.indexOf(this._pendingQueries, deferred);
                if (index !== -1) {
                    let rows = [];
                    for (let  i = 0; i < rs.rows.length; i++) {
                        rows.push(rs.rows.item(i));
                    }
                    this._pendingQueries.splice(index, 1);
                    deferred.resolve(rows);
                } else {
                    console.error('SQL statement resolved twice (success this time): ' + sql);
                }
            }, (t, err) => {
                if (!err) {
                    // The cordova-native-sqlite-storage plugin only passes a single parameter here, the error,
                    // slightly breaking the interface.
                    err = t as any;
                }

                const index = _.indexOf(this._pendingQueries, deferred);
                if (index !== -1) {
                    this._pendingQueries.splice(index, 1);
                    deferred.reject(err);
                } else {
                    console.error('SQL statement resolved twice (this time with failure)');
                }

                return this.getErrorHandlerReturnValue();
            });
        });

        if (errRet) {
            deferred.reject(errRet);
        }

        let promise = deferred.promise();
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlTransaction RunQuery: (' + (Date.now() - startTime) + 'ms): SQL: ' + sql);
            });
        }
        return promise;
    }
}

// DbStore implementation for the SQL-based DbProviders.  Implements the getters/setters against the transaction object and all of the
// glue for index/compound key support.
class SqlStore implements NoSqlProvider.DbStore {
    constructor(private _trans: SqlTransaction, private _schema: NoSqlProvider.StoreSchema, private _replaceUnicode: boolean,
            private _supportsFTS3: boolean, private _verbose: boolean) {
        // Empty
    }

    get(key: KeyType): SyncTasks.Promise<ItemType|undefined> {
        const joinedKey = _.attempt(() => {
            return NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath);
        });
        if (_.isError(joinedKey)) {
            return SyncTasks.Rejected(joinedKey);
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let promise = this._trans.internal_getResultFromQuery('SELECT nsp_data FROM ' + this._schema.name +
            ' WHERE nsp_pk = ?', [joinedKey]);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStore (' + this._schema.name + ') get: (' + (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    }

    getMultiple(keyOrKeys: KeyType|KeyType[]): SyncTasks.Promise<ItemType[]> {
        const joinedKeys = _.attempt(() => {
            return NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        });
        if (_.isError(joinedKeys)) {
            return SyncTasks.Rejected(joinedKeys);
        }

        if (joinedKeys.length === 0) {
            return SyncTasks.Resolved([]);
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        const qmarks = _.map(joinedKeys!!!, k => '?');

        let promise = this._trans.internal_getResultsFromQuery('SELECT nsp_data FROM ' + this._schema.name + ' WHERE nsp_pk IN (' +
            qmarks.join(',') + ')', joinedKeys!!!);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStore (' + this._schema.name + ') getMultiple: (' + (Date.now() - startTime) + 'ms): Count: ' +
                    joinedKeys.length);
            });
        }
        return promise;
    }

    private static _unicodeFixer = new RegExp('[\u2028\u2029]', 'g');

    put(itemOrItems: ItemType|ItemType[]): SyncTasks.Promise<void> {
        let items = NoSqlProviderUtils.arrayify(itemOrItems);

        if (items.length === 0) {
            return SyncTasks.Resolved<void>();
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let fields: string[] = ['nsp_pk', 'nsp_data'];
        let qmarks: string[] = ['?', '?'];
        let args: any[] = [];
        let datas: string[];

        _.each(this._schema.indexes, index => {
            if (!indexUsesSeparateTable(index, this._supportsFTS3)) {
                qmarks.push('?');
                fields.push('nsp_i_' + index.name);
            }
        });

        const qmarkString = qmarks.join(',');
        const err = _.attempt(() => {
            datas = _.map(<any[]>items, (item) => {
                let serializedData = JSON.stringify(item);
                // For now, until an issue with cordova-ios is fixed (https://issues.apache.org/jira/browse/CB-9435), have to replace
                // \u2028 and 2029 with blanks because otherwise the command boundary with cordova-ios silently eats any strings with them.
                if (this._replaceUnicode) {
                    serializedData = serializedData.replace(SqlStore._unicodeFixer, '');
                }
                args.push(NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._schema.primaryKeyPath), serializedData);

                _.each(this._schema.indexes, index => {
                    if (indexUsesSeparateTable(index, this._supportsFTS3)) {
                        return;
                    }

                    if (index.fullText && !this._supportsFTS3) {
                        args.push(FakeFTSJoinToken +
                            FullTextSearchHelpers.getFullTextIndexWordsForItem(<string> index.keyPath, item).join(FakeFTSJoinToken));
                    } else if (!index.multiEntry) {
                        args.push(NoSqlProviderUtils.getSerializedKeyForKeypath(item, index.keyPath));
                    }
                });

                return serializedData;
            });
        });
        if (err) {
            return SyncTasks.Rejected<void>(err);
        }

        // Need to not use too many variables per insert, so batch the insert if needed.
        let queries: SyncTasks.Promise<void>[] = [];
        const itemPageSize = Math.floor(this._trans.internal_getMaxVariables() / fields.length);
        for (let i = 0; i < items.length; i += itemPageSize) {
            const thisPageCount = Math.min(itemPageSize, items.length - i);
            const qmarksValues = _.fill(new Array(thisPageCount), qmarkString);
            queries.push(this._trans.internal_nonQuery('INSERT OR REPLACE INTO ' + this._schema.name + ' (' + fields.join(',') +
                ') VALUES (' + qmarksValues.join('),(') + ')', args.splice(0, thisPageCount * fields.length)));
        }

        // Also prepare mulltiEntry and FullText indexes
        if (_.some(this._schema.indexes, index => indexUsesSeparateTable(index, this._supportsFTS3))) {
            _.each(items, (item, itemIndex) => {
                const key = _.attempt(() => {
                    return NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._schema.primaryKeyPath)!!!;
                });
                if (_.isError(key)) {
                    queries.push(SyncTasks.Rejected<void>(key));
                    return;
                }

                _.each(this._schema.indexes, index => {
                    let serializedKeys: string[];

                    if (index.fullText && this._supportsFTS3) {
                        // FTS3 terms go in a separate virtual table...
                        serializedKeys = [FullTextSearchHelpers.getFullTextIndexWordsForItem(<string> index.keyPath, item).join(' ')];
                    } else if (index.multiEntry) {
                        // Have to extract the multiple entries into the alternate table...
                        const valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, <string>index.keyPath);
                        if (valsRaw) {
                            const err = _.attempt(() => {
                                serializedKeys = _.map(NoSqlProviderUtils.arrayify(valsRaw), val =>
                                    NoSqlProviderUtils.serializeKeyToString(val, <string>index.keyPath));
                            });
                            if (err) {
                                queries.push(SyncTasks.Rejected<void>(err));
                                return;
                            }
                        }
                    } else {
                        return;
                    }

                    let valArgs: string[] = [], insertArgs: string[] = [];
                    _.each(serializedKeys!!!, val => {
                        valArgs.push(index.includeDataInIndex ? '(?, ?, ?)' : '(?, ?)');
                        insertArgs.push(val);
                        insertArgs.push(key);
                        if (index.includeDataInIndex) {
                            insertArgs.push(datas[itemIndex]);
                        }
                    });
                    queries.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name +
                        ' WHERE nsp_refpk = ?', [key])
                    .then(() => {
                        if (valArgs.length > 0) {
                            return this._trans.internal_nonQuery('INSERT INTO ' + this._schema.name + '_' + index.name +
                                ' (nsp_key, nsp_refpk' + (index.includeDataInIndex ? ', nsp_data' : '') + ') VALUES ' +
                                valArgs.join(','), insertArgs);
                        }
                        return undefined;
                    }));
                });
            });
        }

        let promise = SyncTasks.all(queries);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStore (' + this._schema.name + ') put: (' + (Date.now() - startTime) + 'ms): Count: ' + items.length);
            });
        }
        return promise.then(_.noop);
    }

    remove(keyOrKeys: KeyType|KeyType[]): SyncTasks.Promise<void> {
        const joinedKeys = _.attempt(() => {
            return NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        });
        if (_.isError(joinedKeys)) {
            return SyncTasks.Rejected<void>(joinedKeys);
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        // Partition the parameters
        var arrayOfParams: Array<Array<String>> = [[]];
        var totalLength = 0;
        var totalItems = 0;
        var partitionIndex = 0;
        joinedKeys.forEach(joinedKey => {

            // Append the new item to the current partition
            arrayOfParams[partitionIndex].push(joinedKey);

            // Accumulate the length
            totalLength += joinedKey.length + 2;

            totalItems++;

            // Make sure we don't exceed the following sqlite limits, if so go to the next partition
            let didReachSqlStatementLimit = totalLength > (SQLITE_MAX_SQL_LENGTH_IN_BYTES - 200);
            let didExceedMaxVariableCount = totalItems >= this._trans.internal_getMaxVariables();
            if (didReachSqlStatementLimit || didExceedMaxVariableCount) {
                totalLength = 0;
                totalItems = 0;
                partitionIndex++;
                arrayOfParams.push(new Array<String>());
            }
        });

        const queries = _.map(arrayOfParams, params => {
            let queries: SyncTasks.Promise<void>[] = [];

            if (params.length === 0) {
                return undefined;
            }

            // Generate as many '?' as there are params
            let placeholder = '?';
            for (let i = 1; i < params.length; i++) {
                placeholder += ',?';
            }

            _.each(this._schema.indexes, index => {
                if (indexUsesSeparateTable(index, this._supportsFTS3)) {
                    queries.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name +
                        ' WHERE nsp_refpk IN (' + placeholder + ')', params));
                }
            });

            queries.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name +
                ' WHERE nsp_pk IN (' + placeholder + ')', params));

            return SyncTasks.all(queries).then(_.noop);
        });

        let promise = SyncTasks.all(queries).then(_.noop);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStore (' + this._schema.name + ') remove: (' + (Date.now() - startTime) + 'ms): Count: ' +
                    joinedKeys.length);
            });
        }
        return promise;
    }

    openIndex(indexName: string): NoSqlProvider.DbIndex {
        const indexSchema = _.find(this._schema.indexes, index => index.name === indexName);
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }

        return new SqlStoreIndex(this._trans, this._schema, indexSchema, this._supportsFTS3, this._verbose);
    }

    openPrimaryKey(): NoSqlProvider.DbIndex {
        return new SqlStoreIndex(this._trans, this._schema, undefined, this._supportsFTS3, this._verbose);
    }

    clearAllData(): SyncTasks.Promise<void> {
        let indexes = _.filter(this._schema.indexes, index => indexUsesSeparateTable(index, this._supportsFTS3));
        let queries = _.map(indexes, index =>
            this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name));

        queries.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name));

        return SyncTasks.all(queries).then(_.noop);
    }
}

// DbIndex implementation for SQL-based DbProviders.  Wraps all of the nasty compound key logic and general index traversal logic into
// the appropriate SQL queries.
class SqlStoreIndex implements NoSqlProvider.DbIndex {
    private _queryColumn: string;
    private _tableName: string;
    private _rawTableName: string;
    private _indexTableName: string;
    private _keyPath: string | string[];

    constructor(protected _trans: SqlTransaction, storeSchema: NoSqlProvider.StoreSchema, indexSchema: NoSqlProvider.IndexSchema|undefined,
            private _supportsFTS3: boolean, private _verbose: boolean) {
        if (!indexSchema) {
            // Going against the PK of the store
            this._tableName = storeSchema.name;
            this._rawTableName = this._tableName;
            this._indexTableName = this._tableName;
            this._queryColumn = 'nsp_pk';
            this._keyPath = storeSchema.primaryKeyPath;
        } else {
            if (indexUsesSeparateTable(indexSchema, this._supportsFTS3)) {
                if (indexSchema.includeDataInIndex) {
                    this._tableName = storeSchema.name + '_' + indexSchema.name;
                    this._rawTableName = storeSchema.name;
                    this._indexTableName = storeSchema.name + '_' + indexSchema.name;
                    this._queryColumn = 'nsp_key';
                } else {
                    this._tableName = storeSchema.name + '_' + indexSchema.name + ' mi LEFT JOIN ' + storeSchema.name +
                        ' ON mi.nsp_refpk = ' + storeSchema.name + '.nsp_pk';
                    this._rawTableName = storeSchema.name;
                    this._indexTableName = storeSchema.name + '_' + indexSchema.name;
                    this._queryColumn = 'mi.nsp_key';
                }
            } else {
                this._tableName = storeSchema.name;
                this._rawTableName = this._tableName;
                this._indexTableName = this._tableName;
                this._queryColumn = 'nsp_i_' + indexSchema.name;
            }
            this._keyPath = indexSchema.keyPath;
        }
    }

    private _handleQuery(sql: string, args?: any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]> {
        sql += ' ORDER BY ' + this._queryColumn + (reverse ? ' DESC' : ' ASC');

        if (limit) {
            if (limit > LimitMax) {
                if (this._verbose) {
                    console.warn('Limit exceeded in _handleQuery (' + limit + ')');
                }

                limit = LimitMax;
            }
            sql += ' LIMIT ' + limit.toString();
        }
        if (offset) {
            sql += ' OFFSET ' + offset.toString();
        }

        return this._trans.internal_getResultsFromQuery(sql, args);
    }

    getAll(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]> {
        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName, undefined, reverse, limit, offset);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStoreIndex (' + this._rawTableName + '/' + this._indexTableName + ') getAll: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    }

    getOnly(key: KeyType, reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]> {
        const joinedKey = _.attempt(() => {
            return NoSqlProviderUtils.serializeKeyToString(key, this._keyPath);
        });
        if (_.isError(joinedKey)) {
            return SyncTasks.Rejected(joinedKey);
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + this._queryColumn + ' = ?',
            [joinedKey],
            reverse, limit, offset);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStoreIndex (' + this._rawTableName + '/' + this._indexTableName + ') getOnly: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    }

    getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
            reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]> {
        let checks: string;
        let args: string[];
        const err = _.attempt(() => {
            const ret = this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
            checks = ret.checks;
            args = ret.args;
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + checks!!!, args!!!,
            reverse, limit, offset);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStoreIndex (' + this._rawTableName + '/' + this._indexTableName + ') getRange: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    }

    // Warning: This function can throw, make sure to trap.
    private _getRangeChecks(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean,
            highRangeExclusive?: boolean) {
        let checks: string[] = [];
        let args: string[] = [];
        if (keyLowRange !== null && keyLowRange !== undefined) {
            checks.push(this._queryColumn + (lowRangeExclusive ? ' > ' : ' >= ') + '?');
            args.push(NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath));
        }
        if (keyHighRange !== null && keyHighRange !== undefined) {
            checks.push(this._queryColumn + (highRangeExclusive ? ' < ' : ' <= ') + '?');
            args.push(NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath));
        }
        return { checks: checks.join(' AND '), args };
    }

    countAll(): SyncTasks.Promise<number> {
        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let promise = this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName).then(result => result[0]['cnt']);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStoreIndex (' + this._rawTableName + '/' + this._indexTableName + ') countAll: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    }

    countOnly(key: KeyType): SyncTasks.Promise<number> {
        const joinedKey = _.attempt(() => {
            return NoSqlProviderUtils.serializeKeyToString(key, this._keyPath);
        });
        if (_.isError(joinedKey)) {
            return SyncTasks.Rejected(joinedKey);
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let promise = this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName + ' WHERE ' + this._queryColumn
            + ' = ?', [joinedKey]).then(result => result[0]['cnt']);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStoreIndex (' + this._rawTableName + '/' + this._indexTableName + ') countOnly: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    }

    countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
            : SyncTasks.Promise<number> {
        let checks: string;
        let args: string[];
        const err = _.attempt(() => {
            const ret = this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
            checks = ret.checks;
            args = ret.args;
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let promise = this._trans.runQuery('SELECT COUNT(*) cnt FROM ' + this._tableName + ' WHERE ' + checks!!!, args!!!)
            .then(result => result[0]['cnt']);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStoreIndex (' + this._rawTableName + '/' + this._indexTableName + ') countOnly: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    }

    fullTextSearch(searchPhrase: string, resolution: NoSqlProvider.FullTextTermResolution = NoSqlProvider.FullTextTermResolution.And,
            limit?: number): SyncTasks.Promise<ItemType[]> {
        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        const terms = FullTextSearchHelpers.breakAndNormalizeSearchPhrase(searchPhrase);
        if (terms.length === 0) {
            return SyncTasks.Resolved([]);
        }

        let promise: SyncTasks.Promise<ItemType[]>;
        if (this._supportsFTS3) {
            if (resolution === NoSqlProvider.FullTextTermResolution.And) {
                promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + this._queryColumn + ' MATCH ?',
                    [_.map(terms, term => term + '*').join(' ')], false, limit);
            } else if (resolution === NoSqlProvider.FullTextTermResolution.Or) {
                // SQLite FTS3 doesn't support OR queries so we have to hack it...
                const baseQueries = _.map(terms, term => 'SELECT * FROM ' + this._indexTableName + ' WHERE nsp_key MATCH ?');
                const joinedQuery = 'SELECT * FROM (SELECT DISTINCT * FROM (' + baseQueries.join(' UNION ALL ') + ')) mi LEFT JOIN ' +
                    this._rawTableName + ' t ON mi.nsp_refpk = t.nsp_pk';
                const args = _.map(terms, term => term + '*');
                promise = this._handleQuery(joinedQuery, args, false, limit);
            } else {
                return SyncTasks.Rejected('fullTextSearch called with invalid term resolution mode');
            }
        } else {
            let joinTerm: string;
            if (resolution === NoSqlProvider.FullTextTermResolution.And) {
                joinTerm = ' AND ';
            } else if (resolution === NoSqlProvider.FullTextTermResolution.Or) {
                joinTerm = ' OR ';
            } else {
                return SyncTasks.Rejected('fullTextSearch called with invalid term resolution mode');
            }

            promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' +
                _.map(terms, term => this._queryColumn + ' LIKE ?').join(joinTerm),
                _.map(terms, term => '%' + FakeFTSJoinToken + term + '%'));
        }
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStoreIndex (' + this._rawTableName + '/' + this._indexTableName + ') fullTextSearch: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    }
}
