 /**
 * StoreHelpers.ts
 * Author: David de Regt
 * Copyright: Microsoft 2017
 *
 * Reusable helper classes for clients of NoSqlProvider to build more type-safe stores/indexes.
 */

import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import { ItemType, KeyType } from './NoSqlProvider';

export var ErrorCatcher: ((err: any) => SyncTasks.Promise<any>)|undefined = undefined;

// Remove parens from full text search, crashes on React Native....
const FullTextSanitizeRegex = /[()]/g;

// Encodes related type info into the Store/Index name.
// The actual value is just a string, but the type system can extract this extra info.
export type DBStore<Name extends string, ObjectType, KeyFormat> = string & { name?: Name, objectType?: ObjectType, keyFormat?: KeyFormat };
export type DBIndex<Store extends DBStore<string, any, any>, IndexKeyFormat> = string & { store?: Store, indexKeyFormat?: IndexKeyFormat };

export class SimpleTransactionIndexHelper<ObjectType extends ItemType, IndexKeyFormat extends KeyType> {
    constructor(protected _index: NoSqlProvider.DbIndex) {
        // Nothing to see here
    }

    getAll(reverseOrSortOrder?: boolean | NoSqlProvider.QuerySortOrder, limit?: number, offset?: number): SyncTasks.Promise<ObjectType[]> {
        let promise = this._index.getAll(reverseOrSortOrder, limit, offset) as SyncTasks.Promise<ObjectType[]>;
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    getOnly(key: IndexKeyFormat, reverseOrSortOrder?: boolean | NoSqlProvider.QuerySortOrder, limit?: number, offset?: number)
            : SyncTasks.Promise<ObjectType[]> {
        let promise = this._index.getOnly(key, reverseOrSortOrder, limit, offset) as SyncTasks.Promise<ObjectType[]>;
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    getRange(keyLowRange: IndexKeyFormat, keyHighRange: IndexKeyFormat, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverseOrSortOrder?: boolean | NoSqlProvider.QuerySortOrder, limit?: number, offset?: number): SyncTasks.Promise<ObjectType[]> {
        let promise = this._index.getRange(keyLowRange, keyHighRange, lowRangeExclusive,
            highRangeExclusive, reverseOrSortOrder, limit, offset) as SyncTasks.Promise<ObjectType[]>;
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    countAll(): SyncTasks.Promise<number> {
        let promise = this._index.countAll();
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    countOnly(key: IndexKeyFormat): SyncTasks.Promise<number> {
        let promise = this._index.countOnly(key);
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    countRange(keyLowRange: IndexKeyFormat, keyHighRange: IndexKeyFormat,
            lowRangeExclusive?: boolean, highRangeExclusive?: boolean): SyncTasks.Promise<number> {
        let promise = this._index.countRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    fullTextSearch(searchPhrase: string, resolution?: NoSqlProvider.FullTextTermResolution,
            limit?: number): SyncTasks.Promise<ObjectType[]> {
        // Sanitize input by removing parens, the plugin on RN explodes
        let promise = this._index.fullTextSearch(searchPhrase.replace(FullTextSanitizeRegex, ''),
            resolution, limit) as SyncTasks.Promise<ObjectType[]>;
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }
}

export class SimpleTransactionStoreHelper<StoreName extends string, ObjectType extends ItemType, KeyFormat extends KeyType> {
    constructor(protected _store: NoSqlProvider.DbStore, storeName /* Force type-checking */: DBStore<StoreName, ObjectType, KeyFormat>) {
        // Nothing to see here
    }

    get(key: KeyFormat): SyncTasks.Promise<ObjectType|undefined> {
        let promise = this._store.get(key) as SyncTasks.Promise<ObjectType|undefined>;
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    getAll(sortOrder?: NoSqlProvider.QuerySortOrder): SyncTasks.Promise<ObjectType[]> {
        let promise = this._store.openPrimaryKey().getAll(sortOrder) as SyncTasks.Promise<ObjectType[]>;
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    getOnly(key: KeyFormat, reverseOrSortOrder?: boolean | NoSqlProvider.QuerySortOrder, limit?: number, offset?: number)
            : SyncTasks.Promise<ObjectType[]> {
        let promise = this._store.openPrimaryKey().getOnly(key, reverseOrSortOrder, limit, offset) as SyncTasks.Promise<ObjectType[]>;
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    getRange(keyLowRange: KeyFormat, keyHighRange: KeyFormat, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
            reverseOrSortOrder?: boolean | NoSqlProvider.QuerySortOrder, limit?: number, offset?: number): SyncTasks.Promise<ObjectType[]> {
        let promise = this._store.openPrimaryKey().getRange(keyLowRange, keyHighRange,
            lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset) as SyncTasks.Promise<ObjectType[]>;
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    getMultiple(keyOrKeys: KeyFormat|KeyFormat[]): SyncTasks.Promise<ObjectType[]> {
        let promise = this._store.getMultiple(keyOrKeys) as SyncTasks.Promise<ObjectType[]>;
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    openIndex<IndexKeyFormat extends KeyType>(indexName: DBIndex<DBStore<StoreName, ObjectType, KeyFormat>, IndexKeyFormat>)
            : SimpleTransactionIndexHelper<ObjectType, IndexKeyFormat> {
        return new SimpleTransactionIndexHelper<ObjectType, IndexKeyFormat>(this._store.openIndex(indexName));
    }

    openPrimaryKey(): SimpleTransactionIndexHelper<ObjectType, KeyFormat> {
        return new SimpleTransactionIndexHelper<ObjectType, KeyFormat>(this._store.openPrimaryKey());
    }

    put(itemOrItems: ObjectType|ReadonlyArray<ObjectType>): SyncTasks.Promise<void> {
        let promise = this._store.put(itemOrItems);
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    remove(keyOrKeys: KeyFormat|KeyFormat[]): SyncTasks.Promise<void> {
        let promise = this._store.remove(keyOrKeys);
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }

    clearAllData(): SyncTasks.Promise<void> {
        let promise = this._store.clearAllData();
        return ErrorCatcher ? promise.catch(ErrorCatcher) : promise;
    }
}
