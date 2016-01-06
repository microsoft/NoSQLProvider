/**
 * NoSqlProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2016
 *
 * Low-level wrapper to expose a nosql-like database which can be backed by
 * numerous different backend store types, invisible to the consumer.  The
 * usage semantics are very similar to IndexedDB.
 */

export * from './NoSqlProviderInterfaces';
export * from './CordovaNativeSqliteProvider';
export * from './IndexedDbProvider';
export * from './InMemoryProvider';
export * from './NodeSqlite3MemoryDbProvider';
export * from './ReactNativeSqliteProvider';
export * from './WebSqlProvider';
