"use strict";
/**
* FullTextSearchHelpers.ts
* Author: David de Regt
* Copyright: Microsoft 2017
*
* Reusable helper classes and functions for supporting Full Text Search.
*/
var __read = (this && this.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
var __spread = (this && this.__spread) || function () {
    for (var ar = [], i = 0; i < arguments.length; i++) ar = ar.concat(__read(arguments[i]));
    return ar;
};
Object.defineProperty(exports, "__esModule", { value: true });
var lodash_1 = require("lodash");
var regexp_i18n_1 = require("regexp-i18n");
var NoSqlProvider_1 = require("./NoSqlProvider");
var NoSqlProviderUtils_1 = require("./NoSqlProviderUtils");
var _whitespaceRegexMatch = /\S+/g;
// Range which excludes all numbers and digits
var stripSpecialRange = regexp_i18n_1.Ranges.LETTERS_DIGITS_AND_DIACRITICS.invert();
function sqlCompat(value) {
    return regexp_i18n_1.trim(value, stripSpecialRange);
}
function breakAndNormalizeSearchPhrase(phrase) {
    // Deburr and tolower before using words since words breaks on CaseChanges.
    var wordInPhrase = lodash_1.words(lodash_1.deburr(phrase).toLowerCase(), _whitespaceRegexMatch);
    // map(mapKeys is faster than uniq since it's just a pile of strings.
    var uniqueWordas = lodash_1.map(lodash_1.mapKeys(wordInPhrase), function (_value, key) { return sqlCompat(key); });
    return lodash_1.filter(uniqueWordas, function (word) { return !!lodash_1.trim(word); });
}
exports.breakAndNormalizeSearchPhrase = breakAndNormalizeSearchPhrase;
function getFullTextIndexWordsForItem(keyPath, item) {
    var rawString = NoSqlProviderUtils_1.getValueForSingleKeypath(item, keyPath);
    return breakAndNormalizeSearchPhrase(rawString);
}
exports.getFullTextIndexWordsForItem = getFullTextIndexWordsForItem;
var DbIndexFTSFromRangeQueries = /** @class */ (function () {
    function DbIndexFTSFromRangeQueries(_indexSchema, _primaryKeyPath) {
        this._indexSchema = _indexSchema;
        this._primaryKeyPath = _primaryKeyPath;
        this._keyPath = this._indexSchema ? this._indexSchema.keyPath : this._primaryKeyPath;
    }
    DbIndexFTSFromRangeQueries.prototype.fullTextSearch = function (searchPhrase, resolution, limit) {
        var _this = this;
        if (resolution === void 0) { resolution = NoSqlProvider_1.FullTextTermResolution.And; }
        if (!this._indexSchema || !this._indexSchema.fullText) {
            return Promise.reject('fullTextSearch performed against non-fullText index!');
        }
        var terms = breakAndNormalizeSearchPhrase(searchPhrase);
        if (terms.length === 0) {
            return Promise.resolve([]);
        }
        var promises = lodash_1.map(terms, function (term) {
            var upperEnd = term.substr(0, term.length - 1) + String.fromCharCode(term.charCodeAt(term.length - 1) + 1);
            return _this.getRange(term, upperEnd, false, true, false, limit);
        });
        return Promise.all(promises).then(function (results) {
            var uniquers = lodash_1.attempt(function () {
                return lodash_1.map(results, function (resultSet) { return lodash_1.keyBy(resultSet, function (item) {
                    return NoSqlProviderUtils_1.getSerializedKeyForKeypath(item, _this._primaryKeyPath);
                }); });
            });
            if (lodash_1.isError(uniquers)) {
                return Promise.reject(uniquers);
            }
            if (resolution === NoSqlProvider_1.FullTextTermResolution.Or) {
                var data = lodash_1.values(lodash_1.assign.apply(void 0, __spread([{}], uniquers)));
                if (limit) {
                    return lodash_1.take(data, limit);
                }
                return Promise.resolve(data);
            }
            if (resolution === NoSqlProvider_1.FullTextTermResolution.And) {
                var _a = __read(uniquers), first = _a[0], others_1 = _a.slice(1);
                var dic = lodash_1.pickBy(first, function (_value, key) { return lodash_1.every(others_1, function (set) { return key in set; }); });
                var data = lodash_1.values(dic);
                if (limit) {
                    return lodash_1.take(data, limit);
                }
                return Promise.resolve(data);
            }
            return Promise.reject('Undefined full text term resolution type');
        });
    };
    return DbIndexFTSFromRangeQueries;
}());
exports.DbIndexFTSFromRangeQueries = DbIndexFTSFromRangeQueries;
//# sourceMappingURL=FullTextSearchHelpers.js.map