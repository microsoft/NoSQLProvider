/**
 * NoSqlProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2016
 *
 * Low-level wrapper to expose a nosql-like database which can be backed by
 * numerous different backend store types, invisible to the consumer.  The
 * usage semantics are very similar to IndexedDB.
 */
function __export(m) {
    for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
__export(require('./NoSqlProviderInterfaces'));
__export(require('./CordovaNativeSqliteProvider'));
__export(require('./IndexedDbProvider'));
__export(require('./InMemoryProvider'));
__export(require('./NodeSqlite3MemoryDbProvider'));
__export(require('./ReactNativeSqliteProvider'));
__export(require('./WebSqlProvider'));
