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
var FullTextSanitizeRegex = /[()]/g;
var SimpleTransactionIndexHelper = /** @class */ (function () {
    function SimpleTransactionIndexHelper(_index) {
        this._index = _index;
        // Nothing to see here
    }
    SimpleTransactionIndexHelper.prototype.getAll = function (reverseOrSortOrder, limit, offset) {
        var promise = this._index.getAll(reverseOrSortOrder, limit, offset);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionIndexHelper.prototype.getOnly = function (key, reverseOrSortOrder, limit, offset) {
        var promise = this._index.getOnly(key, reverseOrSortOrder, limit, offset);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionIndexHelper.prototype.getRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset) {
        var promise = this._index.getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionIndexHelper.prototype.countAll = function () {
        var promise = this._index.countAll();
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionIndexHelper.prototype.countOnly = function (key) {
        var promise = this._index.countOnly(key);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionIndexHelper.prototype.countRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var promise = this._index.countRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionIndexHelper.prototype.fullTextSearch = function (searchPhrase, resolution, limit) {
        // Sanitize input by removing parens, the plugin on RN explodes
        var promise = this._index.fullTextSearch(searchPhrase.replace(FullTextSanitizeRegex, ''), resolution, limit);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    return SimpleTransactionIndexHelper;
}());
exports.SimpleTransactionIndexHelper = SimpleTransactionIndexHelper;
var SimpleTransactionStoreHelper = /** @class */ (function () {
    function SimpleTransactionStoreHelper(_store, _storeName /* Force type-checking */) {
        this._store = _store;
        // Nothing to see here
    }
    SimpleTransactionStoreHelper.prototype.get = function (key) {
        var promise = this._store.get(key);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionStoreHelper.prototype.getAll = function (sortOrder) {
        var promise = this._store.openPrimaryKey().getAll(sortOrder);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionStoreHelper.prototype.getOnly = function (key, reverseOrSortOrder, limit, offset) {
        var promise = this._store.openPrimaryKey().getOnly(key, reverseOrSortOrder, limit, offset);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionStoreHelper.prototype.getRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset) {
        var promise = this._store.openPrimaryKey().getRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverseOrSortOrder, limit, offset);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionStoreHelper.prototype.getMultiple = function (keyOrKeys) {
        var promise = this._store.getMultiple(keyOrKeys);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionStoreHelper.prototype.openIndex = function (indexName) {
        return new SimpleTransactionIndexHelper(this._store.openIndex(indexName));
    };
    SimpleTransactionStoreHelper.prototype.openPrimaryKey = function () {
        return new SimpleTransactionIndexHelper(this._store.openPrimaryKey());
    };
    SimpleTransactionStoreHelper.prototype.put = function (itemOrItems) {
        var promise = this._store.put(itemOrItems);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionStoreHelper.prototype.remove = function (keyOrKeys) {
        var promise = this._store.remove(keyOrKeys);
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    SimpleTransactionStoreHelper.prototype.clearAllData = function () {
        var promise = this._store.clearAllData();
        return exports.ErrorCatcher ? promise.catch(exports.ErrorCatcher) : promise;
    };
    return SimpleTransactionStoreHelper;
}());
exports.SimpleTransactionStoreHelper = SimpleTransactionStoreHelper;
//# sourceMappingURL=StoreHelpers.js.map