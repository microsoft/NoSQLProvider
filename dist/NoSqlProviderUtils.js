/**
* NoSqlProviderUtils.ts
* Author: David de Regt
* Copyright: Microsoft 2015
*
* Reusable helper functions for NoSqlProvider providers/transactions/etc.
*/
"use strict";
var _ = require('lodash');
function isArray(obj) {
    return (Object.prototype.toString.call(obj) === '[object Array]');
}
exports.isArray = isArray;
function arrayify(obj) {
    return isArray(obj) ? obj : [obj];
}
exports.arrayify = arrayify;
// Constant string for joining compound keypaths for websql and IE indexeddb.  There may be marginal utility in using a more obscure
// string sequence.
var keypathJoinerString = '%&';
// This function computes a serialized single string value for a keypath on an object.  This is used for generating ordered string keys
// for compound (or non-compound) values.
function getSerializedKeyForKeypath(obj, keyPathRaw) {
    var values = getKeyForKeypath(obj, keyPathRaw);
    if (values === null) {
        return null;
    }
    return serializeKeyToString(values, keyPathRaw);
}
exports.getSerializedKeyForKeypath = getSerializedKeyForKeypath;
function getKeyForKeypath(obj, keyPathRaw) {
    var keyPathArray = arrayify(keyPathRaw);
    var values = _.map(keyPathArray, function (kp) { return getValueForSingleKeypath(obj, kp); });
    if (_.some(values, function (val) { return _.isNull(val) || _.isUndefined(val); })) {
        // If any components of the key are null, then the result is null
        return null;
    }
    if (!_.isArray(keyPathRaw)) {
        return values[0];
    }
    else {
        return values;
    }
}
exports.getKeyForKeypath = getKeyForKeypath;
// Internal helper function for getting a value out of a standard keypath.
function getValueForSingleKeypath(obj, keyPath) {
    return _.get(obj, keyPath, null);
}
exports.getValueForSingleKeypath = getValueForSingleKeypath;
function isCompoundKeyPath(keyPath) {
    return isArray(keyPath) && keyPath.length > 1;
}
exports.isCompoundKeyPath = isCompoundKeyPath;
function formListOfKeys(keyOrKeys, keyPath) {
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
exports.formListOfKeys = formListOfKeys;
function serializeValueToOrderableString(val) {
    if (typeof val === 'number') {
        return 'A' + serializeNumberToOrderableString(val);
    }
    if (_.isDate(val)) {
        return 'B' + serializeNumberToOrderableString(val.getTime());
    }
    if (typeof val === 'string') {
        return 'C' + val;
    }
    var type = _.isObject(val) ? Object.getPrototypeOf(val).constructor : typeof val;
    throw new Error('Type \'' + type + '\' unsupported at this time.  Only numbers, Dates, and strings are currently supported.');
}
exports.serializeValueToOrderableString = serializeValueToOrderableString;
var zeroes = '0000000000000000';
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
        if (isArray(key)) {
            return _.map(key, function (k) { return serializeValueToOrderableString(k); }).join(keypathJoinerString);
        }
        else {
            throw new Error('Compound keypath requires compound key');
        }
    }
    else {
        if (isArray(key)) {
            throw new Error('Non-compound keypath requires non-compound key');
        }
        else {
            return serializeValueToOrderableString(key);
        }
    }
}
exports.serializeKeyToString = serializeKeyToString;
function formListOfSerializedKeys(keyOrKeys, keyPath) {
    return _.map(formListOfKeys(keyOrKeys, keyPath), function (key) { return serializeKeyToString(key, keyPath); });
}
exports.formListOfSerializedKeys = formListOfSerializedKeys;
function isIE() {
    return (typeof (document) !== 'undefined' && document.all !== null && document.documentMode <= 11) ||
        (typeof (navigator) !== 'undefined' && navigator.userAgent && navigator.userAgent.indexOf('Edge/') !== -1);
}
exports.isIE = isIE;
