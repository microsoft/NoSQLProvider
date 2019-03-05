/**
 * SqlProviderBase.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * Abstract helpers for all NoSqlProvider DbProviders that are based on SQL backings.
 */

import { ok } from 'assert';
import {
    attempt, isError, repeat, each, some, find, filter,
    isEqual, indexOf, fill, noop, map, flatten, includes, keyBy, partition, intersection
} from 'lodash';
import { breakAndNormalizeSearchPhrase, getFullTextIndexWordsForItem } from './FullTextSearchHelpers';
import {
    StoreSchema, DbProvider, DbSchema, DbTransaction,
    DbIndex, IndexSchema, DbStore, QuerySortOrder, ItemType, KeyType, FullTextTermResolution
} from './NoSqlProvider';
import {
    arrayify, serializeKeyToString, formListOfSerializedKeys,
    getSerializedKeyForKeypath, getValueForSingleKeypath, isCompoundKeyPath
} from './NoSqlProviderUtils';

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
    index: IndexSchema;
}

function getIndexIdentifier(storeSchema: StoreSchema, index: IndexSchema): string {
    return storeSchema.name + '_' + index.name;
}

// Certain indexes use a separate table for pivot:
// * Multientry indexes
// * Full-text indexes that support FTS3
function indexUsesSeparateTable(indexSchema: IndexSchema, supportsFTS3: boolean): boolean {
    return indexSchema.multiEntry || (!!indexSchema.fullText && supportsFTS3);
}

function generateParamPlaceholder(count: number): string {
    ok(count >= 1, 'Must provide at least one parameter to SQL statement');
    // Generate correct count of ?'s and slice off trailing comma
    return repeat('?,', count).slice(0, -1);
}

const FakeFTSJoinToken = '^$^';

// Limit LIMIT numbers to a reasonable size to not break queries.
const LimitMax = Math.pow(2, 32);

export abstract class SqlProviderBase extends DbProvider {
    constructor(protected _supportsFTS3: boolean) {
        super();
        // NOP
    }

    abstract openTransaction(storeNames: string[] | undefined, writeNeeded: boolean): Promise<SqlTransaction>;

    private _getMetadata(trans: SqlTransaction): Promise<{ name: string; value: string; }[]> {
        // Create table if needed
        return trans.runQuery('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)').then(() => {
            return trans.runQuery('SELECT name, value from metadata', []);
        });
    }

    private _storeIndexMetadata(trans: SqlTransaction, meta: IndexMetadata) {
        return trans.runQuery('INSERT OR REPLACE into metadata (\'name\', \'value\') VALUES' +
            '(\'' + meta.key + '\', ?)', [JSON.stringify(meta)]);
    }

    private _getDbVersion(): Promise<number> {
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

    protected _changeDbVersion(oldVersion: number, newVersion: number): Promise<SqlTransaction> {
        return this.openTransaction(undefined, true).then(trans => {
            return trans.runQuery('INSERT OR REPLACE into metadata (\'name\', \'value\') VALUES (\'' + schemaVersionKey + '\', ?)',
                [newVersion])
                .then(() => trans);
        });
    }

    protected _ourVersionChecker(wipeIfExists: boolean): Promise<void> {
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

    protected _upgradeDb(trans: SqlTransaction, oldVersion: number, wipeAnyway: boolean): Promise<void> {
        // Get a list of all tables, columns and indexes on the tables
        return this._getMetadata(trans).then(fullMeta => {
            // Get Index metadatas
            let indexMetadata: IndexMetadata[] =
                map(fullMeta, meta => {
                    const metaObj = attempt(() => {
                        return JSON.parse(meta.value);
                    });
                    if (isError(metaObj)) {
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

                    each(rows, row => {
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
                            return Promise.resolve([]);
                        }

                        // Generate as many '?' as there are params
                        const placeholder = generateParamPlaceholder(metasToDelete.length);

                        return trans.runQuery('DELETE FROM metadata WHERE name IN (' + placeholder + ')',
                            map(metasToDelete, meta => meta.key));
                    };

                    // Check each table!
                    let dropQueries: Promise<any>[] = [];
                    if (wipeAnyway || (this._schema!!!.lastUsableVersion && oldVersion < this._schema!!!.lastUsableVersion!!!)) {
                        // Clear all stores if it's past the usable version
                        if (!wipeAnyway) {
                            console.log('Old version detected (' + oldVersion + '), clearing all tables');
                        }

                        dropQueries = map(tableNames, name => trans.runQuery('DROP TABLE ' + name));

                        if (indexMetadata.length > 0) {
                            // Drop all existing metadata
                            dropQueries.push(deleteFromMeta(indexMetadata));
                            indexMetadata = [];
                        }
                        tableNames = [];
                    } else {
                        // Just delete tables we don't care about anymore. Preserve multi-entry tables, they may not be changed
                        let tableNamesNeeded: string[] = [];
                        each(this._schema!!!.stores, store => {
                            tableNamesNeeded.push(store.name);
                            each(store.indexes, index => {
                                if (indexUsesSeparateTable(index, this._supportsFTS3)) {
                                    tableNamesNeeded.push(getIndexIdentifier(store, index));
                                }
                            });
                        });
                        let tableNamesNotNeeded = filter(tableNames, name => !includes(tableNamesNeeded, name));
                        dropQueries = flatten(map(tableNamesNotNeeded, name => {
                            const transList: Promise<any>[] = [trans.runQuery('DROP TABLE ' + name)];
                            const metasToDelete = filter(indexMetadata, meta => meta.storeName === name);
                            const metaKeysToDelete = map(metasToDelete, meta => meta.key);

                            // Clean up metas
                            if (metasToDelete.length > 0) {
                                transList.push(deleteFromMeta(metasToDelete));
                                indexMetadata = filter(indexMetadata, meta => !includes(metaKeysToDelete, meta.key));
                            }
                            return transList;
                        }));

                        tableNames = filter(tableNames, name => includes(tableNamesNeeded, name));
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

                    each(tableNames, table => {
                        tableColumns[table] = getColumnNames(table);
                    });

                    return Promise.all(dropQueries).then(() => {

                        let tableQueries: Promise<any>[] = [];

                        // Go over each store and see what needs changing
                        each(this._schema!!!.stores, storeSchema => {

                            // creates indexes for provided schemas 
                            const indexMaker = (indexes: IndexSchema[] = []) => {
                                let metaQueries: Promise<any>[] = [];
                                const indexQueries = map(indexes, index => {
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
                                        if (isCompoundKeyPath(index.keyPath)) {
                                            return Promise.reject('Can\'t use multiEntry and compound keys');
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

                                return Promise.all(indexQueries.concat(metaQueries));
                            };

                            // Form SQL statement for table creation
                            let fieldList = [];

                            fieldList.push('nsp_pk TEXT PRIMARY KEY');
                            fieldList.push('nsp_data TEXT');

                            const columnBasedIndices = filter(storeSchema.indexes, index =>
                                !indexUsesSeparateTable(index, this._supportsFTS3));

                            const indexColumnsNames = map(columnBasedIndices, index => 'nsp_i_' + index.name + ' TEXT');
                            fieldList = fieldList.concat(indexColumnsNames);
                            const tableMakerSql = 'CREATE TABLE ' + storeSchema.name + ' (' + fieldList.join(', ') + ')';

                            const currentIndexMetas = filter(indexMetadata, meta => meta.storeName === storeSchema.name);

                            const indexIdentifierDictionary = keyBy(storeSchema.indexes, index => getIndexIdentifier(storeSchema, index));
                            const indexMetaDictionary = keyBy(currentIndexMetas, meta => meta.key);

                            // find which indices in the schema existed / did not exist before
                            const [newIndices, existingIndices] = partition(storeSchema.indexes, index =>
                                !indexMetaDictionary[getIndexIdentifier(storeSchema, index)]);

                            const existingIndexColumns = intersection(existingIndices, columnBasedIndices);

                            // find indices in the meta that do not exist in the new schema
                            const allRemovedIndexMetas = filter(currentIndexMetas, meta =>
                                !indexIdentifierDictionary[meta.key]);

                            const [removedTableIndexMetas, removedColumnIndexMetas] = partition(allRemovedIndexMetas,
                                meta => indexUsesSeparateTable(meta.index, this._supportsFTS3));

                            // find new indices which don't require backfill
                            const newNoBackfillIndices = filter(newIndices, index => {
                                return !!index.doNotBackfill;
                            });

                            // columns requiring no backfill could be simply added to the table
                            const newIndexColumnsNoBackfill = intersection(newNoBackfillIndices, columnBasedIndices);

                            const columnAdder = () => {
                                const addQueries = map(newIndexColumnsNoBackfill, index =>
                                    trans.runQuery('ALTER TABLE ' + storeSchema.name + ' ADD COLUMN ' + 'nsp_i_' + index.name + ' TEXT')
                                );

                                return Promise.all(addQueries);
                            };

                            const tableMaker = () => {
                                // Create the table
                                return trans.runQuery(tableMakerSql)
                                    .then(() => indexMaker(storeSchema.indexes));
                            };

                            const columnExists = (tableName: string, columnName: string) => {
                                return includes(tableColumns[tableName], columnName);
                            };

                            const needsFullMigration = () => {
                                // Check all the indices in the schema
                                return some(storeSchema.indexes, index => {
                                    const indexIdentifier = getIndexIdentifier(storeSchema, index);
                                    const indexMeta = indexMetaDictionary[indexIdentifier];

                                    // if there's a new index that doesn't require backfill, continue
                                    // If there's a new index that requires backfill - we need to migrate 
                                    if (!indexMeta) {
                                        return !index.doNotBackfill;
                                    }

                                    // If the index schemas don't match - we need to migrate
                                    if (!isEqual(indexMeta.index, index)) {
                                        return true;
                                    }

                                    // Check that indicies actually exist in the right place
                                    if (indexUsesSeparateTable(index, this._supportsFTS3)) {
                                        if (!includes(tableNames, indexIdentifier)) {
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
                                return map(indexNames[storeSchema.name], indexName =>
                                    trans.runQuery('DROP INDEX ' + indexName));
                            };

                            const dropIndexTables = (tableNames: string[]) => {
                                return map(tableNames, tableName =>
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
                            const someIndicesMissing = some(columnBasedIndices, index =>
                                columnExists(storeSchema.name, 'nsp_i_' + index.name)
                                && !includes(indexNames[storeSchema.name], getIndexIdentifier(storeSchema, index))
                            );

                            // If the table exists, check if we can to determine if a migration is needed
                            // If a full migration is needed, we have to copy all the data over and re-populate indices
                            // If a in-place migration is enough, we can just copy the data
                            // If no migration is needed, we can just add new column for new indices
                            const tableExists = includes(tableNames, storeSchema.name);
                            const doFullMigration = tableExists && needsFullMigration();
                            const doSqlInPlaceMigration = tableExists && !doFullMigration && removedColumnIndexMetas.length > 0;
                            const adddNewColumns = tableExists && !doFullMigration && !doSqlInPlaceMigration
                                && newNoBackfillIndices.length > 0;
                            const recreateIndices = tableExists && !doFullMigration && !doSqlInPlaceMigration && someIndicesMissing;

                            const indexFixer = () => {
                                if (recreateIndices) {
                                    return indexMaker(storeSchema.indexes);
                                }
                                return Promise.resolve([]);
                            };

                            const indexTableAndMetaDropper = () => {
                                const indexTablesToDrop = doFullMigration
                                    ? indexTables[storeSchema.name] : removedTableIndexMetas.map(meta => meta.key);
                                return Promise.all([deleteFromMeta(allRemovedIndexMetas), ...dropIndexTables(indexTablesToDrop)]);
                            };

                            if (!tableExists) {
                                // Table doesn't exist -- just go ahead and create it without the migration path
                                tableQueries.push(tableMaker());
                            }

                            if (doFullMigration) {
                                // Migrate the data over using our existing put functions
                                // (since it will do the right things with the indexes)
                                // and delete the temp table.
                                const jsMigrator = (batchOffset = 0): Promise<any> => {
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
                                    Promise.all([
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
                                        ...map(existingIndexColumns, index => 'nsp_i_' + index.name)
                                    ].join(', ');

                                    return trans.runQuery('INSERT INTO ' + storeSchema.name + ' (' + columnsToCopy + ')' +
                                        ' SELECT ' + columnsToCopy +
                                        ' FROM temp_' + storeSchema.name);
                                };

                                tableQueries.push(
                                    Promise.all([
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

                        return Promise.all(tableQueries);
                    });
                });
        }).then(noop);
    }
}

// The DbTransaction implementation for the WebSQL DbProvider.  All WebSQL accesses go through the transaction
// object, so this class actually has several helpers for executing SQL queries, getting results from them, etc.
export abstract class SqlTransaction implements DbTransaction {
    private _isOpen = true;

    constructor(
        protected _schema: DbSchema,
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

    abstract getCompletionPromise(): Promise<void>;
    abstract abort(): void;

    abstract runQuery(sql: string, parameters?: any[]): Promise<any[]>;

    internal_getMaxVariables(): number {
        return this._maxVariables;
    }

    internal_nonQuery(sql: string, parameters?: any[]): Promise<void> {
        return this.runQuery(sql, parameters).then<void>(noop);
    }

    internal_getResultsFromQuery<T>(sql: string, parameters?: any[]): Promise<T[]> {
        return this.runQuery(sql, parameters).then((rows) => {
            let rets: T[] = [];
            for (let i = 0; i < rows.length; i++) {
                try {
                    rets.push(JSON.parse(rows[i].nsp_data));
                } catch (e) {
                    return Promise.reject('Error parsing database entry in getResultsFromQuery: ' + JSON.stringify(rows[i].nsp_data));
                }
            }
            return Promise.resolve(rets);
        });
    }

    internal_getResultFromQuery<T>(sql: string, parameters?: any[]): Promise<T | undefined> {
        return this.internal_getResultsFromQuery<T>(sql, parameters)
            .then(rets => rets.length < 1 ? undefined : rets[0]);
    }

    getStore(storeName: string): DbStore {
        const storeSchema = find(this._schema.stores, store => store.name === storeName);
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
    private _pendingQueries: any[] = [];

    constructor(protected _trans: SQLTransaction, schema: DbSchema, verbose: boolean, maxVariables: number,
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
        each(list, query => {
            query.reject(error);
        });
    }

    runQuery(sql: string, parameters?: any[]): Promise<any[]> {
        if (!this._isTransactionOpen()) {
            return Promise.reject('SqliteSqlTransaction already closed');
        }
        let startTime: number;
        const deferred = new Promise<any[]>((resolve, reject) => {
            this._pendingQueries.push(deferred);

            if (this._verbose) {
                startTime = Date.now();
            }

            const errRet = attempt(() => {
                this._trans.executeSql(sql, parameters, (t, rs) => {
                    const index = indexOf(this._pendingQueries, deferred);
                    if (index !== -1) {
                        let rows = [];
                        for (let i = 0; i < rs.rows.length; i++) {
                            rows.push(rs.rows.item(i));
                        }
                        this._pendingQueries.splice(index, 1);
                        resolve(rows);
                    } else {
                        console.error('SQL statement resolved twice (success this time): ' + sql);
                    }
                }, (t, err) => {
                    if (!err) {
                        // The cordova-native-sqlite-storage plugin only passes a single parameter here, the error,
                        // slightly breaking the interface.
                        err = t as any;
                    }

                    const index = indexOf(this._pendingQueries, deferred);
                    if (index !== -1) {
                        this._pendingQueries.splice(index, 1);
                        reject(err);
                    } else {
                        console.error('SQL statement resolved twice (this time with failure)');
                    }

                    return this.getErrorHandlerReturnValue();
                });
            });

            if (errRet) {
                reject(errRet);
            }
        });

        let promise = deferred;
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
class SqlStore implements DbStore {
    constructor(private _trans: SqlTransaction, private _schema: StoreSchema, private _replaceUnicode: boolean,
        private _supportsFTS3: boolean, private _verbose: boolean) {
        // Empty
    }

    get(key: KeyType): Promise<ItemType | undefined> {
        const joinedKey = attempt(() => {
            return serializeKeyToString(key, this._schema.primaryKeyPath);
        });
        if (isError(joinedKey)) {
            return Promise.reject(joinedKey);
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

    getMultiple(keyOrKeys: KeyType | KeyType[]): Promise<ItemType[]> {
        const joinedKeys = attempt(() => {
            return formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        });
        if (isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }

        if (joinedKeys.length === 0) {
            return Promise.resolve([]);
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let promise = this._trans.internal_getResultsFromQuery('SELECT nsp_data FROM ' + this._schema.name + ' WHERE nsp_pk IN (' +
            generateParamPlaceholder(joinedKeys.length) + ')', joinedKeys);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStore (' + this._schema.name + ') getMultiple: (' + (Date.now() - startTime) + 'ms): Count: ' +
                    joinedKeys.length);
            });
        }
        return promise;
    }

    private static _unicodeFixer = new RegExp('[\u2028\u2029]', 'g');

    put(itemOrItems: ItemType | ItemType[]): Promise<void> {
        let items = arrayify(itemOrItems);

        if (items.length === 0) {
            return Promise.resolve<void>(void 0);
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let fields: string[] = ['nsp_pk', 'nsp_data'];
        let qmarks: string[] = ['?', '?'];
        let args: any[] = [];
        let datas: string[];

        each(this._schema.indexes, index => {
            if (!indexUsesSeparateTable(index, this._supportsFTS3)) {
                qmarks.push('?');
                fields.push('nsp_i_' + index.name);
            }
        });

        const qmarkString = qmarks.join(',');
        const err = attempt(() => {
            datas = map(<any[]>items, (item) => {
                let serializedData = JSON.stringify(item);
                // For now, until an issue with cordova-ios is fixed (https://issues.apache.org/jira/browse/CB-9435), have to replace
                // \u2028 and 2029 with blanks because otherwise the command boundary with cordova-ios silently eats any strings with them.
                if (this._replaceUnicode) {
                    serializedData = serializedData.replace(SqlStore._unicodeFixer, '');
                }
                args.push(getSerializedKeyForKeypath(item, this._schema.primaryKeyPath), serializedData);

                each(this._schema.indexes, index => {
                    if (indexUsesSeparateTable(index, this._supportsFTS3)) {
                        return;
                    }

                    if (index.fullText && !this._supportsFTS3) {
                        args.push(FakeFTSJoinToken +
                            getFullTextIndexWordsForItem(<string>index.keyPath, item).join(FakeFTSJoinToken));
                    } else if (!index.multiEntry) {
                        args.push(getSerializedKeyForKeypath(item, index.keyPath));
                    }
                });

                return serializedData;
            });
        });
        if (err) {
            return Promise.reject<void>(err);
        }

        // Need to not use too many variables per insert, so batch the insert if needed.
        let queries: Promise<void>[] = [];
        const itemPageSize = Math.floor(this._trans.internal_getMaxVariables() / fields.length);
        for (let i = 0; i < items.length; i += itemPageSize) {
            const thisPageCount = Math.min(itemPageSize, items.length - i);
            const qmarksValues = fill(new Array(thisPageCount), qmarkString);
            queries.push(this._trans.internal_nonQuery('INSERT OR REPLACE INTO ' + this._schema.name + ' (' + fields.join(',') +
                ') VALUES (' + qmarksValues.join('),(') + ')', args.splice(0, thisPageCount * fields.length)));
        }

        // Also prepare mulltiEntry and FullText indexes
        if (some(this._schema.indexes, index => indexUsesSeparateTable(index, this._supportsFTS3))) {
            const keysToDeleteByIndex: { [indexIndex: number]: string[] } = {};
            const dataToInsertByIndex: { [indexIndex: number]: string[] } = {};

            each(items, (item, itemIndex) => {
                const key = attempt(() => {
                    return getSerializedKeyForKeypath(item, this._schema.primaryKeyPath)!!!;
                });
                if (isError(key)) {
                    queries.push(Promise.reject<void>(key));
                    return;
                }

                each(this._schema.indexes, (index, indexIndex) => {
                    let serializedKeys: string[];

                    if (index.fullText && this._supportsFTS3) {
                        // FTS3 terms go in a separate virtual table...
                        serializedKeys = [getFullTextIndexWordsForItem(<string>index.keyPath, item).join(' ')];
                    } else if (index.multiEntry) {
                        // Have to extract the multiple entries into the alternate table...
                        const valsRaw = getValueForSingleKeypath(item, <string>index.keyPath);
                        if (valsRaw) {
                            const serializedKeysOrErr = attempt(() => {
                                return map(arrayify(valsRaw), val =>
                                    serializeKeyToString(val, <string>index.keyPath));
                            });
                            if (isError(serializedKeysOrErr)) {
                                queries.push(Promise.reject<void>(serializedKeysOrErr));
                                return;
                            }
                            serializedKeys = serializedKeysOrErr;
                        } else {
                            serializedKeys = [];
                        }
                    } else {
                        return;
                    }

                    // Capture insert data
                    if (serializedKeys.length > 0) {
                        if (!dataToInsertByIndex[indexIndex]) {
                            dataToInsertByIndex[indexIndex] = [];
                        }
                        const dataToInsert = dataToInsertByIndex[indexIndex];
                        each(serializedKeys, val => {
                            dataToInsert.push(val);
                            dataToInsert.push(key);
                            if (index.includeDataInIndex) {
                                dataToInsert.push(datas[itemIndex]);
                            }
                        });
                    }

                    // Capture delete keys
                    if (!keysToDeleteByIndex[indexIndex]) {
                        keysToDeleteByIndex[indexIndex] = [];
                    }

                    keysToDeleteByIndex[indexIndex].push(key);
                });
            });

            const deleteQueries: Promise<void>[] = [];

            each(keysToDeleteByIndex, (keysToDelete, indedIndex) => {
                // We know indexes are defined if we have data to insert for them
                // each spits dictionary keys out as string, needs to turn into a number
                const index = this._schema.indexes!!![Number(indedIndex)];
                const itemPageSize = this._trans.internal_getMaxVariables();
                for (let i = 0; i < keysToDelete.length; i += itemPageSize) {
                    const thisPageCount = Math.min(itemPageSize, keysToDelete.length - i);
                    deleteQueries.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name +
                        ' WHERE nsp_refpk IN (' + generateParamPlaceholder(thisPageCount) + ')', keysToDelete.splice(0, thisPageCount)));
                }
            });

            // Delete and insert tracking - cannot insert until delete is completed
            queries.push(Promise.all(deleteQueries).then(() => {
                const insertQueries: Promise<void>[] = [];
                each(dataToInsertByIndex, (data, indexIndex) => {
                    // We know indexes are defined if we have data to insert for them
                    // each spits dictionary keys out as string, needs to turn into a number
                    const index = this._schema.indexes!!![Number(indexIndex)];
                    const insertParamCount = index.includeDataInIndex ? 3 : 2;
                    const itemPageSize = Math.floor(this._trans.internal_getMaxVariables() / insertParamCount);
                    // data contains all the input parameters
                    for (let i = 0; i < (data.length / insertParamCount); i += itemPageSize) {
                        const thisPageCount = Math.min(itemPageSize, (data.length / insertParamCount) - i);
                        const qmarksValues = fill(new Array(thisPageCount), generateParamPlaceholder(insertParamCount));
                        insertQueries.push(this._trans.internal_nonQuery('INSERT INTO ' +
                            this._schema.name + '_' + index.name + ' (nsp_key, nsp_refpk' + (index.includeDataInIndex ? ', nsp_data' : '') +
                            ') VALUES ' + '(' + qmarksValues.join('),(') + ')', data.splice(0, thisPageCount * insertParamCount)));
                    }
                });
                return Promise.all(insertQueries).then(noop);
            }));

        }

        let promise = Promise.all(queries);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStore (' + this._schema.name + ') put: (' + (Date.now() - startTime) + 'ms): Count: ' + items.length);
            });
        }
        return promise.then(noop);
    }

    remove(keyOrKeys: KeyType | KeyType[]): Promise<void> {
        const joinedKeys = attempt(() => {
            return formListOfSerializedKeys(keyOrKeys, this._schema.primaryKeyPath);
        });
        if (isError(joinedKeys)) {
            return Promise.reject<void>(joinedKeys);
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

        const queries = map(arrayOfParams, params => {
            let queries: Promise<void>[] = [];

            if (params.length === 0) {
                return undefined;
            }

            // Generate as many '?' as there are params
            const placeholder = generateParamPlaceholder(params.length);

            each(this._schema.indexes, index => {
                if (indexUsesSeparateTable(index, this._supportsFTS3)) {
                    queries.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name +
                        ' WHERE nsp_refpk IN (' + placeholder + ')', params));
                }
            });

            queries.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name +
                ' WHERE nsp_pk IN (' + placeholder + ')', params));

            return Promise.all(queries).then(noop);
        });

        let promise = Promise.all(queries).then(noop);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStore (' + this._schema.name + ') remove: (' + (Date.now() - startTime) + 'ms): Count: ' +
                    joinedKeys.length);
            });
        }
        return promise;
    }

    openIndex(indexName: string): DbIndex {
        const indexSchema = find(this._schema.indexes, index => index.name === indexName);
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }

        return new SqlStoreIndex(this._trans, this._schema, indexSchema, this._supportsFTS3, this._verbose);
    }

    openPrimaryKey(): DbIndex {
        return new SqlStoreIndex(this._trans, this._schema, undefined, this._supportsFTS3, this._verbose);
    }

    clearAllData(): Promise<void> {
        let indexes = filter(this._schema.indexes, index => indexUsesSeparateTable(index, this._supportsFTS3));
        let queries = map(indexes, index =>
            this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name + '_' + index.name));

        queries.push(this._trans.internal_nonQuery('DELETE FROM ' + this._schema.name));

        return Promise.all(queries).then(noop);
    }
}

// DbIndex implementation for SQL-based DbProviders.  Wraps all of the nasty compound key logic and general index traversal logic into
// the appropriate SQL queries.
class SqlStoreIndex implements DbIndex {
    private _queryColumn: string;
    private _tableName: string;
    private _rawTableName: string;
    private _indexTableName: string;
    private _keyPath: string | string[];

    constructor(protected _trans: SqlTransaction, storeSchema: StoreSchema, indexSchema: IndexSchema | undefined,
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

    private _handleQuery(sql: string, args?: any[], reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number,
        offset?: number): Promise<ItemType[]> {
        // Check if we must do some sort of ordering
        if (reverseOrSortOrder !== QuerySortOrder.None) {
            const reverse = reverseOrSortOrder === true || reverseOrSortOrder === QuerySortOrder.Reverse;
            sql += ' ORDER BY ' + this._queryColumn + (reverse ? ' DESC' : ' ASC');
        }

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

    getAll(reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]> {
        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName, undefined, reverseOrSortOrder, limit, offset);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStoreIndex (' + this._rawTableName + '/' + this._indexTableName + ') getAll: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    }

    getOnly(key: KeyType, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number)
        : Promise<ItemType[]> {
        const joinedKey = attempt(() => {
            return serializeKeyToString(key, this._keyPath);
        });
        if (isError(joinedKey)) {
            return Promise.reject(joinedKey);
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + this._queryColumn + ' = ?',
            [joinedKey], reverseOrSortOrder, limit, offset);
        if (this._verbose) {
            promise = promise.finally(() => {
                console.log('SqlStoreIndex (' + this._rawTableName + '/' + this._indexTableName + ') getOnly: (' +
                    (Date.now() - startTime) + 'ms)');
            });
        }
        return promise;
    }

    getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]> {
        let checks: string;
        let args: string[];
        const err = attempt(() => {
            const ret = this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
            checks = ret.checks;
            args = ret.args;
        });
        if (err) {
            return Promise.reject(err);
        }

        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        let promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + checks!!!, args!!!,
            reverseOrSortOrder, limit, offset);
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
            args.push(serializeKeyToString(keyLowRange, this._keyPath));
        }
        if (keyHighRange !== null && keyHighRange !== undefined) {
            checks.push(this._queryColumn + (highRangeExclusive ? ' < ' : ' <= ') + '?');
            args.push(serializeKeyToString(keyHighRange, this._keyPath));
        }
        return { checks: checks.join(' AND '), args };
    }

    countAll(): Promise<number> {
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

    countOnly(key: KeyType): Promise<number> {
        const joinedKey = attempt(() => {
            return serializeKeyToString(key, this._keyPath);
        });
        if (isError(joinedKey)) {
            return Promise.reject(joinedKey);
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
        : Promise<number> {
        let checks: string;
        let args: string[];
        const err = attempt(() => {
            const ret = this._getRangeChecks(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
            checks = ret.checks;
            args = ret.args;
        });
        if (err) {
            return Promise.reject(err);
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

    fullTextSearch(searchPhrase: string, resolution: FullTextTermResolution = FullTextTermResolution.And,
        limit?: number): Promise<ItemType[]> {
        let startTime: number;
        if (this._verbose) {
            startTime = Date.now();
        }

        const terms = breakAndNormalizeSearchPhrase(searchPhrase);
        if (terms.length === 0) {
            return Promise.resolve([]);
        }

        let promise: Promise<ItemType[]>;
        if (this._supportsFTS3) {
            if (resolution === FullTextTermResolution.And) {
                promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' + this._queryColumn + ' MATCH ?',
                    [map(terms, term => term + '*').join(' ')], false, limit);
            } else if (resolution === FullTextTermResolution.Or) {
                // SQLite FTS3 doesn't support OR queries so we have to hack it...
                const baseQueries = map(terms, term => 'SELECT * FROM ' + this._indexTableName + ' WHERE nsp_key MATCH ?');
                const joinedQuery = 'SELECT * FROM (SELECT DISTINCT * FROM (' + baseQueries.join(' UNION ALL ') + ')) mi LEFT JOIN ' +
                    this._rawTableName + ' t ON mi.nsp_refpk = t.nsp_pk';
                const args = map(terms, term => term + '*');
                promise = this._handleQuery(joinedQuery, args, false, limit);
            } else {
                return Promise.reject('fullTextSearch called with invalid term resolution mode');
            }
        } else {
            let joinTerm: string;
            if (resolution === FullTextTermResolution.And) {
                joinTerm = ' AND ';
            } else if (resolution === FullTextTermResolution.Or) {
                joinTerm = ' OR ';
            } else {
                return Promise.reject('fullTextSearch called with invalid term resolution mode');
            }

            promise = this._handleQuery('SELECT nsp_data FROM ' + this._tableName + ' WHERE ' +
                map(terms, term => this._queryColumn + ' LIKE ?').join(joinTerm),
                map(terms, term => '%' + FakeFTSJoinToken + term + '%'));
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
