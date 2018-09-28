 /**
 * FullTextSearchHelpers.ts
 * Author: David de Regt
 * Copyright: Microsoft 2017
 *
 * Reusable helper classes and functions for supporting Full Text Search.
 */

import _ = require('lodash');
import { Ranges, trim } from 'regexp-i18n';
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import { ItemType, KeyType } from './NoSqlProvider';
import NoSqlProviderUtils = require('./NoSqlProviderUtils');

const _whitespaceRegexMatch = /\S+/g;

// Range which excludes all numbers and digits
const stripSpecialRange = Ranges.LETTERS_DIGITS_AND_DIACRITICS.invert();

function sqlCompat(value: string): string {
    return trim(value, stripSpecialRange);
}

export function breakAndNormalizeSearchPhrase(phrase: string): string[] {
    // Deburr and tolower before using _.words since _.words breaks on CaseChanges.
    const words = _.words(_.deburr(phrase).toLowerCase(), _whitespaceRegexMatch);
    // _.map(_.mapKeys is faster than _.uniq since it's just a pile of strings.
    const uniqueWordas = _.map(_.mapKeys(words), (value, key) => sqlCompat(key));
    return _.filter(uniqueWordas, word => !!_.trim(word));
}

export function getFullTextIndexWordsForItem(keyPath: string, item: any): string[] {
    const rawString = NoSqlProviderUtils.getValueForSingleKeypath(item, keyPath);

    return breakAndNormalizeSearchPhrase(rawString);
}

export abstract class DbIndexFTSFromRangeQueries implements NoSqlProvider.DbIndex {
    protected _keyPath: string | string[];

    constructor(protected _indexSchema: NoSqlProvider.IndexSchema|undefined, protected _primaryKeyPath: string | string[]) {
        this._keyPath = this._indexSchema ? this._indexSchema.keyPath : this._primaryKeyPath;
    }

    fullTextSearch(searchPhrase: string, 
        resolution: NoSqlProvider.FullTextTermResolution = NoSqlProvider.FullTextTermResolution.And, limit?: number)
            : SyncTasks.Promise<ItemType[]> {
        if (!this._indexSchema || !this._indexSchema.fullText) {
            return SyncTasks.Rejected('fullTextSearch performed against non-fullText index!');
        }

        const terms = breakAndNormalizeSearchPhrase(searchPhrase);
        if (terms.length === 0) {
            return SyncTasks.Resolved([]);
        }

        const promises = _.map(terms, term => {
            const upperEnd = term.substr(0, term.length - 1) + String.fromCharCode(term.charCodeAt(term.length - 1) + 1);
            return this.getRange(term, upperEnd, false, true, false, limit);
        });
        return SyncTasks.all(promises).then(results => {
            const uniquers = _.attempt(() => {
                return _.map(results, resultSet => _.keyBy(resultSet, item =>
                    NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._primaryKeyPath)));
            });
            if (_.isError(uniquers)) {
                return SyncTasks.Rejected(uniquers);
            }

            if (resolution === NoSqlProvider.FullTextTermResolution.Or) {
                const data = _.values(_.assign({}, ...uniquers));
                if (limit) {
                    return _.take(data, limit);
                }
                return data;
            }

            if (resolution === NoSqlProvider.FullTextTermResolution.And) {
                const [first, ...others] = uniquers;
                const dic = _.pickBy(first, (value, key) => _.every(others, set => key in set)) as _.Dictionary<ItemType>;
                const data = _.values(dic);
                if (limit) {
                    return _.take(data, limit);
                }
                return data;
            }

            return SyncTasks.Rejected('Undefined full text term resolution type');
        });
    }

    abstract getAll(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]>;
    abstract getOnly(key: KeyType, reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]>;
    abstract getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]>;
    abstract countAll(): SyncTasks.Promise<number>;
    abstract countOnly(key: KeyType): SyncTasks.Promise<number>;
    abstract countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : SyncTasks.Promise<number>;
}
