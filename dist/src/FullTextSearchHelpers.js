"use strict";
/**
* FullTextSearchHelpers.ts
* Author: David de Regt
* Copyright: Microsoft 2017
*
* Reusable helper classes and functions for supporting Full Text Search.
*/
Object.defineProperty(exports, "__esModule", { value: true });
const lodash_1 = require("lodash");
const regexp_i18n_1 = require("regexp-i18n");
const NoSqlProvider_1 = require("./NoSqlProvider");
const NoSqlProviderUtils_1 = require("./NoSqlProviderUtils");
const _whitespaceRegexMatch = /\S+/g;
// Range which excludes all numbers and digits
const stripSpecialRange = regexp_i18n_1.Ranges.LETTERS_DIGITS_AND_DIACRITICS.invert();
function sqlCompat(value) {
    return regexp_i18n_1.trim(value, stripSpecialRange);
}
function breakAndNormalizeSearchPhrase(phrase) {
    // Deburr and tolower before using words since words breaks on CaseChanges.
    const wordInPhrase = lodash_1.words(lodash_1.deburr(phrase).toLowerCase(), _whitespaceRegexMatch);
    // map(mapKeys is faster than uniq since it's just a pile of strings.
    const uniqueWordas = lodash_1.map(lodash_1.mapKeys(wordInPhrase), (_value, key) => sqlCompat(key));
    return lodash_1.filter(uniqueWordas, word => !!lodash_1.trim(word));
}
exports.breakAndNormalizeSearchPhrase = breakAndNormalizeSearchPhrase;
function getFullTextIndexWordsForItem(keyPath, item) {
    const rawString = NoSqlProviderUtils_1.getValueForSingleKeypath(item, keyPath);
    return breakAndNormalizeSearchPhrase(rawString);
}
exports.getFullTextIndexWordsForItem = getFullTextIndexWordsForItem;
class DbIndexFTSFromRangeQueries {
    constructor(_indexSchema, _primaryKeyPath) {
        this._indexSchema = _indexSchema;
        this._primaryKeyPath = _primaryKeyPath;
        this._keyPath = this._indexSchema ? this._indexSchema.keyPath : this._primaryKeyPath;
    }
    fullTextSearch(searchPhrase, resolution = NoSqlProvider_1.FullTextTermResolution.And, limit) {
        if (!this._indexSchema || !this._indexSchema.fullText) {
            return Promise.reject('fullTextSearch performed against non-fullText index!');
        }
        const terms = breakAndNormalizeSearchPhrase(searchPhrase);
        if (terms.length === 0) {
            return Promise.resolve([]);
        }
        const promises = lodash_1.map(terms, term => {
            const upperEnd = term.substr(0, term.length - 1) + String.fromCharCode(term.charCodeAt(term.length - 1) + 1);
            return this.getRange(term, upperEnd, false, true, false, limit);
        });
        return Promise.all(promises).then(results => {
            const uniquers = lodash_1.attempt(() => {
                return lodash_1.map(results, resultSet => lodash_1.keyBy(resultSet, item => NoSqlProviderUtils_1.getSerializedKeyForKeypath(item, this._primaryKeyPath)));
            });
            if (lodash_1.isError(uniquers)) {
                return Promise.reject(uniquers);
            }
            if (resolution === NoSqlProvider_1.FullTextTermResolution.Or) {
                const data = lodash_1.values(lodash_1.assign({}, ...uniquers));
                if (limit) {
                    return lodash_1.take(data, limit);
                }
                return Promise.resolve(data);
            }
            if (resolution === NoSqlProvider_1.FullTextTermResolution.And) {
                const [first, ...others] = uniquers;
                const dic = lodash_1.pickBy(first, (_value, key) => lodash_1.every(others, set => key in set));
                const data = lodash_1.values(dic);
                if (limit) {
                    return lodash_1.take(data, limit);
                }
                return Promise.resolve(data);
            }
            return Promise.reject('Undefined full text term resolution type');
        });
    }
}
exports.DbIndexFTSFromRangeQueries = DbIndexFTSFromRangeQueries;
//# sourceMappingURL=FullTextSearchHelpers.js.map