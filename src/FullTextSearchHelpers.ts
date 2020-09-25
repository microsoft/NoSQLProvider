 /**
 * FullTextSearchHelpers.ts
 * Author: David de Regt
 * Copyright: Microsoft 2017
 *
 * Reusable helper classes and functions for supporting Full Text Search.
 */

import {
    words, map, mapKeys, deburr, filter, attempt, keyBy,
    isError, pickBy, values, every, Dictionary, assign, take, trim as lodashTrim
} from 'lodash';
import { Ranges, trim } from 'regexp-i18n';
import SyncTasks = require('synctasks');

import { DbIndex, IndexSchema, QuerySortOrder, FullTextTermResolution, ItemType, KeyType } from './NoSqlProvider';
import { getValueForSingleKeypath, getSerializedKeyForKeypath } from './NoSqlProviderUtils';

const _whitespaceRegexMatch = /\S+/g;

// Range which excludes all numbers and digits
const stripSpecialRange = Ranges.LETTERS_DIGITS_AND_DIACRITICS.invert();

function sqlCompat(value: string): string {
    return trim(value, stripSpecialRange);
}

export function breakAndNormalizeSearchPhrase(phrase: string): string[] {
    // Deburr and tolower before using words since words breaks on CaseChanges.
    const deconstructedWords = words(deburr(phrase).toLowerCase(), _whitespaceRegexMatch);
    // map(mapKeys is faster than uniq since it's just a pile of strings.
    const uniqueWordas = map(mapKeys(deconstructedWords), (value, key) => sqlCompat(key));
    return filter(uniqueWordas, word => !!lodashTrim(word));
}

export function getFullTextIndexWordsForItem(keyPath: string, item: any): string[] {
    const rawString = getValueForSingleKeypath(item, keyPath);

    return breakAndNormalizeSearchPhrase(rawString);
}

export abstract class DbIndexFTSFromRangeQueries implements DbIndex {
    protected _keyPath: string | string[];

    constructor(protected _indexSchema: IndexSchema|undefined, protected _primaryKeyPath: string | string[]) {
        this._keyPath = this._indexSchema ? this._indexSchema.keyPath : this._primaryKeyPath;
    }

    fullTextSearch(searchPhrase: string, 
        resolution: FullTextTermResolution = FullTextTermResolution.And, limit?: number)
            : SyncTasks.Promise<ItemType[]> {
        if (!this._indexSchema || !this._indexSchema.fullText) {
            return SyncTasks.Rejected('fullTextSearch performed against non-fullText index!');
        }

        const terms = breakAndNormalizeSearchPhrase(searchPhrase);
        if (terms.length === 0) {
            return SyncTasks.Resolved([]);
        }

        const promises = map(terms, term => {
            const upperEnd = term.substr(0, term.length - 1) + String.fromCharCode(term.charCodeAt(term.length - 1) + 1);
            return this.getRange(term, upperEnd, false, true, false, limit);
        });
        return SyncTasks.all(promises).then(results => {
            const uniquers = attempt(() => {
                return map(results, resultSet => keyBy(resultSet, item =>
                    getSerializedKeyForKeypath(item, this._primaryKeyPath)));
            });
            if (isError(uniquers)) {
                return SyncTasks.Rejected(uniquers);
            }

            if (resolution === FullTextTermResolution.Or) {
                const data = values(assign({}, ...uniquers));
                if (limit) {
                    return take(data, limit);
                }
                return data;
            }

            if (resolution === FullTextTermResolution.And) {
                const [first, ...others] = uniquers;
                const dic = pickBy(first, (value, key) => every(others, set => key in set)) as Dictionary<ItemType>;
                const data = values(dic);
                if (limit) {
                    return take(data, limit);
                }
                return data;
            }

            return SyncTasks.Rejected('Undefined full text term resolution type');
        });
    }

    abstract getAll(reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number)
        : SyncTasks.Promise<ItemType[]>;
    abstract getOnly(key: KeyType, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number)
        : SyncTasks.Promise<ItemType[]>;
    abstract getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverseOrSortOrder?: boolean|QuerySortOrder, limit?: number, offset?: number): SyncTasks.Promise<ItemType[]>;
    abstract countAll(): SyncTasks.Promise<number>;
    abstract countOnly(key: KeyType): SyncTasks.Promise<number>;
    abstract countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : SyncTasks.Promise<number>;
}
