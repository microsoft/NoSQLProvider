 /**
 * NoSqlProviderUtils.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * Reusable helper functions for NoSqlProvider providers/transactions/etc.
 */

import _ = require('lodash');

export function isArray(obj: any): boolean {
    return (Object.prototype.toString.call(obj) === '[object Array]');
}

export function arrayify<T>(obj: T | T[]): T[] {
    return isArray(obj) ? <T[]>obj : [<T>obj];
}

// Constant string for joining compound keypaths for websql and IE indexeddb.  There may be marginal utility in using a more obscure
// string sequence.
const keypathJoinerString = '%&';

// This function computes a serialized single string value for a keypath on an object.  This is used for generating ordered string keys
// for compound (or non-compound) values.
export function getSerializedKeyForKeypath(obj: any, keyPathRaw: string | string[]): string {
    const values = getKeyForKeypath(obj, keyPathRaw);
    if (values === null) {
        return null;
    }

    return serializeKeyToString(values, keyPathRaw);
}

export function getKeyForKeypath(obj: any, keyPathRaw: string | string[]): any {
    const keyPathArray = arrayify(keyPathRaw);

    const values = _.map(keyPathArray, kp => getValueForSingleKeypath(obj, kp));
    if (_.some(values, val => _.isNull(val) || _.isUndefined(val))) {
        // If any components of the key are null, then the result is null
        return null;
    }

    if (!_.isArray(keyPathRaw)) {
        return values[0];
    } else {
        return values;
    }
}

// Internal helper function for getting a value out of a standard keypath.
export function getValueForSingleKeypath(obj: any, keyPath: string): any {
    return _.get<any>(obj, keyPath, null);
}

export function isCompoundKeyPath(keyPath: string | string[]) {
    return isArray(keyPath) && keyPath.length > 1;
}

export function formListOfKeys(keyOrKeys: any | any[], keyPath: string | string[]): any[] {
    if (isCompoundKeyPath(keyPath)) {
        if (!isArray(keyOrKeys)) {
            throw new Error('Compound keypath requires compound keys');
        }
        if (!isArray(keyOrKeys[0])) {
            // Looks like a single compound key, so make it a list of a single key
            return [keyOrKeys];
        }

        // Array of arrays, so looks fine
        return keyOrKeys;
    }

    // Non-compound, so just make sure it's a list when it comes out in case it's a single key passed
    return arrayify(keyOrKeys);
}

export function serializeValueToOrderableString(val: any) {
    if (typeof val === 'number') {
        return 'A' + serializeNumberToOrderableString(val as number);
    }
    if (_.isDate(val)) {
        return 'B' + serializeNumberToOrderableString((val as Date).getTime());
    }
    if (typeof val === 'string') {
        return 'C' + (val as string);
    }

    const type = _.isObject(val) ? Object.getPrototypeOf(val).constructor : typeof val;
    throw new Error('Type \'' + type + '\' unsupported at this time.  Only numbers, Dates, and strings are currently supported.');
}

const zeroes = '0000000000000000';

function formatFixed(n: number, digits: number): string {
    var result = String(n);
    var prefix = digits - result.length;

    if (prefix > 0 && prefix < zeroes.length) {
        result = zeroes.substr(0, prefix) + result;
    }

    return result;
}

export function serializeNumberToOrderableString(n: number) {
    if (n === 0 || isNaN(n) || !isFinite(n)) {
        return String(n);
    }

    var isPositive = true;

    if (n < 0) {
        isPositive = false;
        n = -n;
    }

    var exponent = Math.floor(Math.log(n) / Math.LN10);

    n = n / Math.pow(10, exponent);

    if (isPositive) {
        return formatFixed(1024 + exponent, 4) + String(n);
    } else {
        return '-' + formatFixed(1024 - exponent, 4) + String(10 - n);
    }
}

export function serializeKeyToString(key: any | any[], keyPath: string | string[]): string {
    if (isCompoundKeyPath(keyPath)) {
        if (isArray(key)) {
            return _.map(key, k => serializeValueToOrderableString(k)).join(keypathJoinerString);
        } else {
            throw new Error('Compound keypath requires compound key');
        }
    } else {
        if (isArray(key)) {
            throw new Error('Non-compound keypath requires non-compound key');
        } else {
            return serializeValueToOrderableString(key);
        }
    }
}

export function formListOfSerializedKeys(keyOrKeys: any | any[], keyPath: string | string[]): string[] {
    return _.map(formListOfKeys(keyOrKeys, keyPath), key => serializeKeyToString(key, keyPath));
}

export function isIE() {
    return (typeof (document) !== 'undefined' && document.all !== null && document.documentMode <= 11) ||
        (typeof (navigator) !== 'undefined' && navigator.userAgent && navigator.userAgent.indexOf('Edge/') !== -1);
}

export function breakWords(rawString: string): string[] {
    // Figure out how to do this in a localized fashion
    return rawString.split(' ');
}

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

export function normalizeSearchTerm(term: string): string {
    return normalizeString(term).toLowerCase();
}
