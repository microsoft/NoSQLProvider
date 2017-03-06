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

const _charMap: { [char: string]: string } = {
    'ª': 'a', 'º': 'o', 'À': 'A', 'Á': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'Å': 'A', 'Ç': 'C', 'È': 'E',
    'É': 'E', 'Ê': 'E', 'Ë': 'E', 'Ì': 'I', 'Í': 'I', 'Î': 'I', 'Ï': 'I', 'Ñ': 'N', 'Ò': 'O', 'Ó': 'O',
    'Ô': 'O', 'Õ': 'O', 'Ö': 'O', 'Ù': 'U', 'Ú': 'U', 'Û': 'U', 'Ü': 'U', 'Ý': 'Y', 'à': 'a', 'á': 'a',
    'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a', 'ç': 'c', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e', 'ì': 'i',
    'í': 'i', 'î': 'i', 'ï': 'i', 'ñ': 'n', 'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o', 'ù': 'u',
    'ú': 'u', 'û': 'u', 'ü': 'u', 'ý': 'y', 'ÿ': 'y', 'Ā': 'A', 'ā': 'a', 'Ă': 'A', 'ă': 'a', 'Ą': 'A',
    'ą': 'a', 'Ć': 'C', 'ć': 'c', 'Ĉ': 'C', 'ĉ': 'c', 'Ċ': 'C', 'ċ': 'c', 'Č': 'C', 'č': 'c', 'Ď': 'D',
    'ď': 'd', 'Ē': 'E', 'ē': 'e', 'Ĕ': 'E', 'ĕ': 'e', 'Ė': 'E', 'ė': 'e', 'Ę': 'E', 'ę': 'e', 'Ě': 'E',
    'ě': 'e', 'Ĝ': 'G', 'ĝ': 'g', 'Ğ': 'G', 'ğ': 'g', 'Ġ': 'G', 'ġ': 'g', 'Ģ': 'G', 'ģ': 'g', 'Ĥ': 'H',
    'ĥ': 'h', 'Ĩ': 'I', 'ĩ': 'i', 'Ī': 'I', 'ī': 'i', 'Ĭ': 'I', 'ĭ': 'i', 'Į': 'I', 'į': 'i', 'İ': 'I',
    'Ĳ': 'IJ', 'ĳ': 'ij', 'Ĵ': 'J', 'ĵ': 'j', 'Ķ': 'K', 'ķ': 'k', 'Ĺ': 'L', 'ĺ': 'l', 'Ļ': 'L', 'ļ': 'l',
    'Ľ': 'L', 'ľ': 'l', 'Ŀ': 'L·', 'ŀ': 'l·', 'Ń': 'N', 'ń': 'n', 'Ņ': 'N', 'ņ': 'n', 'Ň': 'N', 'ň': 'n',
    'ŉ': 'ʼn', 'Ō': 'O', 'ō': 'o', 'Ŏ': 'O', 'ŏ': 'o', 'Ő': 'O', 'ő': 'o', 'Ŕ': 'R', 'ŕ': 'r', 'Ŗ': 'R',
    'ŗ': 'r', 'Ř': 'R', 'ř': 'r', 'Ś': 'S', 'ś': 's', 'Ŝ': 'S', 'ŝ': 's', 'Ş': 'S', 'ş': 's', 'Š': 'S',
    'š': 's', 'Ţ': 'T', 'ţ': 't', 'Ť': 'T', 'ť': 't', 'Ũ': 'U', 'ũ': 'u', 'Ū': 'U', 'ū': 'u', 'Ŭ': 'U',
    'ŭ': 'u', 'Ů': 'U', 'ů': 'u', 'Ű': 'U', 'ű': 'u', 'Ų': 'U', 'ų': 'u', 'Ŵ': 'W', 'ŵ': 'w', 'Ŷ': 'Y',
    'ŷ': 'y', 'Ÿ': 'Y', 'Ź': 'Z', 'ź': 'z', 'Ż': 'Z', 'ż': 'z', 'Ž': 'Z', 'ž': 'z', 'ſ': 's', 'Ơ': 'O',
    'ơ': 'o', 'Ư': 'U', 'ư': 'u', 'Ǆ': 'DZ', 'ǅ': 'Dz', 'ǆ': 'dz', 'Ǉ': 'LJ', 'ǈ': 'Lj', 'ǉ': 'lj',
    'Ǌ': 'NJ', 'ǋ': 'Nj', 'ǌ': 'nj', 'Ǎ': 'A', 'ǎ': 'a', 'Ǐ': 'I', 'ǐ': 'i', 'Ǒ': 'O', 'ǒ': 'o', 'Ǔ': 'U',
    'ǔ': 'u', 'Ǖ': 'U', 'ǖ': 'u', 'Ǘ': 'U', 'ǘ': 'u', 'Ǚ': 'U', 'ǚ': 'u', 'Ǜ': 'U', 'ǜ': 'u', 'Ǟ': 'A',
    'ǟ': 'a', 'Ǡ': 'A', 'ǡ': 'a', 'Ǧ': 'G', 'ǧ': 'g', 'Ǩ': 'K', 'ǩ': 'k', 'Ǫ': 'O', 'ǫ': 'o', 'Ǭ': 'O',
    'ǭ': 'o', 'ǰ': 'j', 'Ǳ': 'DZ', 'ǲ': 'Dz', 'ǳ': 'dz', 'Ǵ': 'G', 'ǵ': 'g', 'Ǹ': 'N', 'ǹ': 'n', 'Ǻ': 'A',
    'ǻ': 'a', 'Ȁ': 'A', 'ȁ': 'a', 'Ȃ': 'A', 'ȃ': 'a', 'Ȅ': 'E', 'ȅ': 'e', 'Ȇ': 'E', 'ȇ': 'e', 'Ȉ': 'I',
    'ȉ': 'i', 'Ȋ': 'I', 'ȋ': 'i', 'Ȍ': 'O', 'ȍ': 'o', 'Ȏ': 'O', 'ȏ': 'o', 'Ȑ': 'R', 'ȑ': 'r', 'Ȓ': 'R',
    'ȓ': 'r', 'Ȕ': 'U', 'ȕ': 'u', 'Ȗ': 'U', 'ȗ': 'u', 'Ș': 'S', 'ș': 's', 'Ț': 'T', 'ț': 't', 'Ȟ': 'H',
    'ȟ': 'h', 'Ȧ': 'A', 'ȧ': 'a', 'Ȩ': 'E', 'ȩ': 'e', 'Ȫ': 'O', 'ȫ': 'o', 'Ȭ': 'O', 'ȭ': 'o', 'Ȯ': 'O',
    'ȯ': 'o', 'Ȱ': 'O', 'ȱ': 'o', 'Ȳ': 'Y', 'ȳ': 'y', 'ʰ': 'h', 'ʲ': 'j', 'ʳ': 'r', 'ʷ': 'w', 'ʸ': 'y',
    'ˡ': 'l', 'ˢ': 's', 'ˣ': 'x'
};
const _minLead = parseInt('0xD800', 16);
const _maxLead = parseInt('0xDBFF', 16);

export function normalizeString(input: string): string {
    // Constants for leading byte-range.
    let currentChar = '';
    let output = '';

    if (!input) {
        return input;
    }

    for (var i = 0; i < input.length; i++) {
        currentChar += input.charAt(i);
        const code = input.charCodeAt(i);
        if (code < _minLead || code > _maxLead) {
            output += _charMap[currentChar] ? _charMap[currentChar] : currentChar;
            currentChar = '';
        }
    }

    return output;
}

export function breakWords(rawString: string): string[] {
    // Figure out how to do this in a localized fashion
    return rawString.split(' ');
}

export function breakAndNormalizeSearchPhrase(phrase: string): string[] {
    return _.uniq(_.map(breakWords(phrase), word => normalizeSearchTerm(word)));
}

export function normalizeSearchTerm(term: string): string {
    return normalizeString(term).toLowerCase();
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
