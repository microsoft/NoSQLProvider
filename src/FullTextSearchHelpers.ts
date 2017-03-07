 /**
 * FullTextSearchHelpers.ts
 * Author: David de Regt
 * Copyright: Microsoft 2017
 *
 * Reusable helper classes and functions for supporting Full Text Search.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import NoSqlProviderUtils = require('./NoSqlProviderUtils');

export function breakAndNormalizeSearchPhrase(phrase: string): string[] {
    // Faster than using _.uniq since it's just a pile of strings.
    // Deburr and tolower before using _.words since _.words breaks on CaseChanges.
    return _.keys(_.mapKeys(_.words(_.deburr(phrase).toLowerCase())));
}

export function getFullTextIndexWordsForItem(keyPath: string, item: any): string[] {
    const rawString = NoSqlProviderUtils.getValueForSingleKeypath(item, keyPath);

    return breakAndNormalizeSearchPhrase(rawString);
}

export abstract class DbIndexFTSFromRangeQueries implements NoSqlProvider.DbIndex {
    constructor(protected _primaryKeyPath: string | string[]) {
        // NOP
    }

    fullTextSearch<T>(searchPhrase: string): SyncTasks.Promise<T[]> {
        const promises = _.map(breakAndNormalizeSearchPhrase(searchPhrase), term => {
            const upperEnd = term.substr(0, term.length - 1) + String.fromCharCode(term.charCodeAt(term.length - 1) + 1);
            return this.getRange(term, upperEnd, false, true);
        });
        return SyncTasks.all(promises).then(results => {
            if (results.length === 1) {
                return results[0];
            }

            // Only return terms that show up in all of the results sets.
            // The @types for _.intersectionBy is wrong and needs fixing, so this will hack around that for now...
            return (_.intersectionBy as any)(...results, item =>
                NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._primaryKeyPath));
        });
    }

    abstract getAll<T>(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    abstract getOnly<T>(key: any|any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    abstract getRange<T>(keyLowRange: any|any[], keyHighRange: any|any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    abstract countAll(): SyncTasks.Promise<number>;
    abstract countOnly(key: any|any[]): SyncTasks.Promise<number>;
    abstract countRange(keyLowRange: any|any[], keyHighRange: any|any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : SyncTasks.Promise<number>;
}
