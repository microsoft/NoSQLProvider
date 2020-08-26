"use strict";
/**
* NoSqlProviderUtils.ts
* Author: David de Regt
* Copyright: Microsoft 2015
*
* Reusable helper functions for NoSqlProvider providers/transactions/etc.
*/
Object.defineProperty(exports, "__esModule", { value: true });
const lodash_1 = require("lodash");
function isIE() {
    return (typeof (document) !== 'undefined' && document.all !== null && document.documentMode <= 11) ||
        (typeof (navigator) !== 'undefined' && !!navigator.userAgent && navigator.userAgent.indexOf('Edge/') !== -1);
}
exports.isIE = isIE;
function isSafari() {
    return (typeof (navigator) !== 'undefined' && ((navigator.userAgent.indexOf('Safari') !== -1 &&
        navigator.userAgent.indexOf('Chrome') === -1 && navigator.userAgent.indexOf('BB10') === -1) ||
        (navigator.userAgent.indexOf('Mobile Crosswalk') !== -1)));
}
exports.isSafari = isSafari;
function arrayify(obj) {
    return lodash_1.isArray(obj) ? obj : [obj];
}
exports.arrayify = arrayify;
// Constant string for joining compound keypaths for websql and IE indexeddb.  There may be marginal utility in using a more obscure
// string sequence.
const keypathJoinerString = '%&';
// This function computes a serialized single string value for a keypath on an object.  This is used for generating ordered string keys
// for compound (or non-compound) values.
function getSerializedKeyForKeypath(obj, keyPathRaw) {
    const values = getKeyForKeypath(obj, keyPathRaw);
    if (values === undefined) {
        return undefined;
    }
    return serializeKeyToString(values, keyPathRaw);
}
exports.getSerializedKeyForKeypath = getSerializedKeyForKeypath;
function getKeyForKeypath(obj, keyPathRaw) {
    const keyPathArray = arrayify(keyPathRaw);
    const values = lodash_1.map(keyPathArray, kp => getValueForSingleKeypath(obj, kp));
    if (lodash_1.some(values, val => lodash_1.isNull(val) || lodash_1.isUndefined(val))) {
        // If any components of the key are null/undefined, then the result is undefined
        return undefined;
    }
    if (!lodash_1.isArray(keyPathRaw)) {
        return values[0];
    }
    else {
        return values;
    }
}
exports.getKeyForKeypath = getKeyForKeypath;
// Internal helper function for getting a value out of a standard keypath.
function getValueForSingleKeypath(obj, singleKeyPath) {
    return lodash_1.get(obj, singleKeyPath, undefined);
}
exports.getValueForSingleKeypath = getValueForSingleKeypath;
function isCompoundKeyPath(keyPath) {
    return lodash_1.isArray(keyPath) && keyPath.length > 1;
}
exports.isCompoundKeyPath = isCompoundKeyPath;
function formListOfKeys(keyOrKeys, keyPath) {
    if (isCompoundKeyPath(keyPath)) {
        if (!lodash_1.isArray(keyOrKeys)) {
            throw new Error('formListOfKeys called with a compound keypath (' + JSON.stringify(keyPath) +
                ') but a non-compound keyOrKeys (' + JSON.stringify(keyOrKeys) + ')');
        }
        if (!lodash_1.isArray(keyOrKeys[0])) {
            // Looks like a single compound key, so make it a list of a single key
            return [keyOrKeys];
        }
        // Array of arrays, so looks fine
        return keyOrKeys;
    }
    // Non-compound, so just make sure it's a list when it comes out in case it's a single key passed
    return arrayify(keyOrKeys);
}
exports.formListOfKeys = formListOfKeys;
function serializeValueToOrderableString(val) {
    if (typeof val === 'number') {
        return 'A' + serializeNumberToOrderableString(val);
    }
    if (lodash_1.isDate(val)) {
        return 'B' + serializeNumberToOrderableString(val.getTime());
    }
    if (typeof val === 'string') {
        return 'C' + val;
    }
    const type = lodash_1.isObject(val) ? Object.getPrototypeOf(val).constructor : typeof val;
    throw new Error('Type \'' + type + '\' unsupported at this time.  Only numbers, Dates, and strings are currently supported.');
}
exports.serializeValueToOrderableString = serializeValueToOrderableString;
const zeroes = '0000000000000000';
function formatFixed(n, digits) {
    var result = String(n);
    var prefix = digits - result.length;
    if (prefix > 0 && prefix < zeroes.length) {
        result = zeroes.substr(0, prefix) + result;
    }
    return result;
}
function serializeNumberToOrderableString(n) {
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
    }
    else {
        return '-' + formatFixed(1024 - exponent, 4) + String(10 - n);
    }
}
exports.serializeNumberToOrderableString = serializeNumberToOrderableString;
function serializeKeyToString(key, keyPath) {
    if (isCompoundKeyPath(keyPath)) {
        if (lodash_1.isArray(key)) {
            return lodash_1.map(key, k => serializeValueToOrderableString(k)).join(keypathJoinerString);
        }
        else {
            throw new Error('serializeKeyToString called with a compound keypath (' + JSON.stringify(keyPath) +
                ') but a non-compound key (' + JSON.stringify(key) + ')');
        }
    }
    else {
        if (lodash_1.isArray(key)) {
            throw new Error('serializeKeyToString called with a non-compound keypath (' + JSON.stringify(keyPath) +
                ') but a compound key (' + JSON.stringify(key) + ')');
        }
        else {
            return serializeValueToOrderableString(key);
        }
    }
}
exports.serializeKeyToString = serializeKeyToString;
function formListOfSerializedKeys(keyOrKeys, keyPath) {
    return lodash_1.map(formListOfKeys(keyOrKeys, keyPath), key => serializeKeyToString(key, keyPath));
}
exports.formListOfSerializedKeys = formListOfSerializedKeys;
//# sourceMappingURL=NoSqlProviderUtils.js.map