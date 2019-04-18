"use strict";
/**
* StoreHelpers.ts
* Author: David de Regt
* Copyright: Microsoft 2017
*
* Reusable helper classes for clients of NoSqlProvider to build more type-safe stores/indexes.
*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorCatcher = undefined;
// Remove parens from full text search, crashes on React Native....
const FullTextSanitizeRegex = /[()]/g;
class SimpleTransactionIndexHelper {
    constructor(_index) {
        this._index = _index;
        // Nothing to see here
    }
    getAll(reverseOrSortOrder, limit, offset) {
        let promise = this._index.getAll(reverseOrSortOrder, limit, offset);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    getOnly(key, reverseOrSortOrder, limit, offset) {
        let promise = this._index.getOnly(key, reverseOrSortOrder, limit, offset);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset) {
        let promise = this._index.getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    countAll() {
        let promise = this._index.countAll();
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    countOnly(key) {
        let promise = this._index.countOnly(key);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    countRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        let promise = this._index.countRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    fullTextSearch(searchPhrase, resolution, limit) {
        // Sanitize input by removing parens, the plugin on RN explodes
        let promise = this._index.fullTextSearch(searchPhrase.replace(FullTextSanitizeRegex, ''), resolution, limit);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
}
exports.SimpleTransactionIndexHelper = SimpleTransactionIndexHelper;
class SimpleTransactionStoreHelper {
    constructor(_store, _storeName /* Force type-checking */) {
        this._store = _store;
        // Nothing to see here
    }
    get(key) {
        let promise = this._store.get(key);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    getAll(sortOrder) {
        let promise = this._store.openPrimaryKey().getAll(sortOrder);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    getOnly(key, reverseOrSortOrder, limit, offset) {
        let promise = this._store.openPrimaryKey().getOnly(key, reverseOrSortOrder, limit, offset);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset) {
        let promise = this._store.openPrimaryKey().getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    getMultiple(keyOrKeys) {
        let promise = this._store.getMultiple(keyOrKeys);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    openIndex(indexName) {
        return new SimpleTransactionIndexHelper(this._store.openIndex(indexName));
    }
    openPrimaryKey() {
        return new SimpleTransactionIndexHelper(this._store.openPrimaryKey());
    }
    put(itemOrItems) {
        let promise = this._store.put(itemOrItems);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    remove(keyOrKeys) {
        let promise = this._store.remove(keyOrKeys);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
    clearAllData() {
        let promise = this._store.clearAllData();
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    }
}
exports.SimpleTransactionStoreHelper = SimpleTransactionStoreHelper;
//# sourceMappingURL=StoreHelpers.js.map