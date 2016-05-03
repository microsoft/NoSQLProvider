// Cordova-created global objects that TypeScript needs to know about
//declare var device: any;
//declare var cordova: any;

// Back-compat
interface Document {
    documentMode: number;
}

// WebSQL/IndexedDB definitions that typescript needs to know about

interface Window {
    _indexedDB: IDBFactory;
    mozIndexedDB: IDBFactory;
    webkitIndexedDB: IDBFactory;
    msIndexedDB: IDBFactory;

    openDatabase(database_name: string, database_version: string, database_displayname: string, database_size?: number, creationCallback?: DatabaseCallback): Database;
}

interface IDBObjectStore {
    createIndex(name: string, keyPath: string | string[], optionalParameters?: any): IDBIndex;
}

interface DatabaseCallback {
    (database: Database): void;
}

interface SQLVoidCallback {
    (): void;
}

interface SQLTransactionCallback {
    (transaction: SQLTransaction): void;
}

interface SQLTransactionErrorCallback {
    (error: SQLError): void;
}

interface Database {
    version: string;

    changeVersion(oldVersion: string, newVersion: string, callback?: SQLTransactionCallback, errorCallback?: SQLTransactionErrorCallback, successCallback?: SQLVoidCallback);
    transaction(callback?: SQLTransactionCallback, errorCallback?: SQLTransactionErrorCallback, successCallback?: SQLVoidCallback);
    readTransaction(callback?: SQLTransactionCallback, errorCallback?: SQLTransactionErrorCallback, successCallback?: SQLVoidCallback);
}

interface SQLStatementCallback {
    (transaction: SQLTransaction, resultSet: SQLResultSet): void;
}

interface SQLStatementErrorCallback {
    (transaction: SQLTransaction, error: SQLError): void;
}

interface SQLTransaction {
    executeSql(sqlStatement: string, arguments?: any[], callback?: SQLStatementCallback, errorCallback?: SQLStatementErrorCallback);
}

declare enum SQLErrors {
    UNKNOWN_ERR = 0,
    DATABASE_ERR = 1,
    VERSION_ERR = 2,
    TOO_LARGE_ERR = 3,
    QUOTA_ERR = 4,
    SYNTAX_ERR = 5,
    CONSTRAINT_ERR = 6,
    TIMEOUT_ERR = 7
}

interface SQLError {
    code: number;
    message: string;
}

interface SQLResultSet {
    insertId: number;
    rowsAffected: number;
    rows: SQLResultSetRowList;
}

interface SQLResultSetRowList {
    length: number;
    item(index: number): any;
}

declare module 'indexeddb-js' {
    function makeScope(driverName: string, engine: any): IDBScope;
    interface IDBScope {
        IDBKeyRange: any;
        indexedDB: IDBFactory;
    }
}


/*
 * cordova-sqlite.d.ts
 *
 * Type definitions for cordova sqlite plugin
 */

interface Window {
    sqlitePlugin: SqlitePlugin
}
