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

    const values = keyPathArray.map(kp => getValueForSingleKeypath(obj, kp));
    if (_.any(values, val => _.isNull(val) || _.isUndefined(val))) {
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
            throw 'Compound keypath requires compound keys';
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
    throw 'Type \'' + type + '\' unsupported at this time.  Only numbers, Dates, and strings are currently supported.';
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
            return key.map(k => serializeValueToOrderableString(k)).join(keypathJoinerString);
        } else {
            throw 'Compound keypath requires compound key';
        }
    } else {
        if (isArray(key)) {
            throw 'Non-compound keypath requires non-compound key';
        } else {
            return serializeValueToOrderableString(key);
        }
    }
}

export function formListOfSerializedKeys(keyOrKeys: any | any[], keyPath: string | string[]): string[] {
    return formListOfKeys(keyOrKeys, keyPath).map(key => serializeKeyToString(key, keyPath));
}
