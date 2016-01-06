var assert = require('assert');
var _ = require('lodash');
var SyncTasks = require('synctasks');
var sqlite3 = require('sqlite3');
var indexeddbjs = require('indexeddb-js');
var NoSqlProvider = require('../NoSqlProvider');
var NoSqlProviderUtils = require('../NoSqlProviderUtils');
var NodeSqlite3MemoryDbProvider = require('../NodeSqlite3MemoryDbProvider');
var IndexedDbProvider = require('../IndexedDbProvider');
var InMemoryProvider = require('../InMemoryProvider');
function openProvider(providerName, schema) {
    var provider = null;
    if (providerName === 'sqlite3test') {
        provider = new NodeSqlite3MemoryDbProvider();
    }
    else if (providerName === 'indexeddbtest') {
        var engine = new sqlite3.Database(':memory:');
        var scope = indexeddbjs.makeScope('sqlite3', engine);
        global['IDBKeyRange'] = scope.IDBKeyRange;
        var idbFactory = scope.indexedDB;
        provider = new IndexedDbProvider(idbFactory, false);
    }
    else if (providerName === 'memory') {
        provider = new InMemoryProvider();
    }
    return NoSqlProvider.openListOfProviders([provider], 'test', schema, true);
}
describe('NoSqlProvider', function () {
    var provsToTest = ['sqlite3test', 'indexeddbtest', 'memory'];
    it('Number/value/type sorting', function () {
        var pairsToTest = [
            [0, 1],
            [-1, 1],
            [100, 100.1],
            [-123456.789, -123456.78],
            [-123456.789, 0],
            [-123456.789, 123456.789],
            [0.000012345, 8],
            [0.000012345, 0.00002],
            [-0.000012345, 0.000000001],
            [1, Date.now()],
            [new Date(0), new Date(2)],
            [new Date(1), new Date(2)],
            [new Date(-1), new Date(1)],
            [new Date(-2), new Date(-1)],
            [new Date(-2), new Date(0)],
            [1, 'hi'],
            [-1, 'hi'],
            [Date.now(), 'hi'],
            ['hi', 'hi2'],
            ['a', 'b']
        ];
        pairsToTest.forEach(function (pair) {
            assert(NoSqlProviderUtils.serializeValueToOrderableString(pair[0]) <
                NoSqlProviderUtils.serializeValueToOrderableString(pair[1]), 'failed for pair: ' + pair);
        });
        try {
            NoSqlProviderUtils.serializeValueToOrderableString([4, 5]);
            assert(false, 'Should reject this key');
        }
        catch (e) {
        }
    });
    provsToTest.forEach(function (provName) {
        describe('Provider: ' + provName, function () {
            // Setter should set the testable parameter on the first param to the value in the second param, and third param to the
            // second index column for compound indexes.
            var tester = function (prov, indexName, compound, setter, noRange) {
                if (noRange === void 0) { noRange = false; }
                var putters = [1, 2, 3, 4, 5].map(function (v) {
                    var obj = { val: 'val' + v };
                    if (indexName) {
                        obj.id = 'id' + v;
                    }
                    setter(obj, 'indexa' + v, 'indexb' + v);
                    return prov.put('test', obj);
                });
                return SyncTasks.whenAll(putters).then(function (rets) {
                    var formIndex = function (i, i2) {
                        if (i2 === void 0) { i2 = i; }
                        if (compound) {
                            return ['indexa' + i, 'indexb' + i2];
                        }
                        else {
                            return 'indexa' + i;
                        }
                    };
                    var t1 = prov.getAll('test', indexName).then(function (ret) {
                        assert.equal(ret.length, 5, 'getAll');
                        [1, 2, 3, 4, 5].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; }), 'cant find ' + v); });
                    });
                    var t1b = (provName === 'indexeddbtest') ? null : prov.getAll('test', indexName, false, 3).then(function (ret) {
                        assert.equal(ret.length, 3, 'getAll lim3');
                        [1, 2, 3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; }), 'cant find ' + v); });
                    });
                    var t1c = (provName === 'indexeddbtest') ? null : prov.getAll('test', indexName, false, 3, 1).then(function (ret) {
                        assert.equal(ret.length, 3, 'getAll lim3 off1');
                        [2, 3, 4].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; }), 'cant find ' + v); });
                    });
                    var t2 = noRange ? null : prov.getOnly('test', indexName, formIndex(3)).then(function (ret) {
                        assert.equal(ret.length, 1, 'getOnly');
                        assert.equal(ret[0].val, 'val3');
                    });
                    var t3 = noRange ? null : prov.getRange('test', indexName, formIndex(2), formIndex(4)).then(function (ret) {
                        assert.equal(ret.length, 3, 'getRange++');
                        [2, 3, 4].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                    });
                    var t3b = (noRange || provName === 'indexeddbtest') ? null :
                        prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 1).then(function (ret) {
                            assert.equal(ret.length, 1, 'getRange++ lim1');
                            [2].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                    var t3b2 = (noRange || provName === 'indexeddbtest') ? null :
                        prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, true, 1).then(function (ret) {
                            assert.equal(ret.length, 1, 'getRange++ lim1 rev');
                            [4].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                    var t3c = (noRange || provName === 'indexeddbtest') ? null :
                        prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 1, 1).then(function (ret) {
                            assert.equal(ret.length, 1, 'getRange++ lim1 off1');
                            [3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                    var t3d = (noRange || provName === 'indexeddbtest') ? null :
                        prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 2, 1).then(function (ret) {
                            assert.equal(ret.length, 2, 'getRange++ lim2 off1');
                            [3, 4].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                    var t3d2 = (noRange || provName === 'indexeddbtest') ? null :
                        prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, true, 2, 1).then(function (ret) {
                            assert.equal(ret.length, 2, 'getRange++ lim2 off1 rev');
                            assert.equal(ret[0].val, 'val3');
                            [2, 3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                    var t4 = noRange ? null : prov.getRange('test', indexName, formIndex(2), formIndex(4), true, false).then(function (ret) {
                        assert.equal(ret.length, 2, 'getRange-+');
                        [3, 4].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                    });
                    var t5 = noRange ? null : prov.getRange('test', indexName, formIndex(2), formIndex(4), false, true).then(function (ret) {
                        assert.equal(ret.length, 2, 'getRange+-');
                        [2, 3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                    });
                    var t6 = noRange ? null : prov.getRange('test', indexName, formIndex(2), formIndex(4), true, true).then(function (ret) {
                        assert.equal(ret.length, 1, 'getRange--');
                        [3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                    });
                    return SyncTasks.whenAll([t1, t1b, t1c, t2, t3, t3b, t3b2, t3c, t3d, t3d2, t4, t5, t6]).then(function () {
                        if (compound) {
                            var tt1 = noRange ? null : prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3))
                                .then(function (ret) {
                                assert.equal(ret.length, 2, 'getRange2++');
                                [2, 3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                            });
                            var tt2 = noRange ? null : prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3), false, true)
                                .then(function (ret) {
                                assert.equal(ret.length, 2, 'getRange2+-');
                                [2, 3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                            });
                            var tt3 = noRange ? null : prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3), true, false)
                                .then(function (ret) {
                                assert.equal(ret.length, 1, 'getRange2-+');
                                [3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                            });
                            return SyncTasks.whenAll([tt1, tt2, tt3]);
                        }
                    });
                });
            };
            it('Simple primary key put/get/getAll', function () {
                return openProvider(provName, {
                    version: 1,
                    stores: [
                        {
                            name: 'test',
                            primaryKeyPath: 'id'
                        }
                    ]
                }).then(function (prov) {
                    return prov.put('test', { id: 'a', val: 'b' }).then(function () {
                        return prov.get('test', 'a').then(function (ret) {
                            assert.equal(ret.val, 'b');
                            return prov.getAll('test').then(function (ret2) {
                                assert.equal(ret2.length, 1);
                                assert.equal(ret2[0].val, 'b');
                            });
                        });
                    });
                });
            });
            it('Primary Key Basic KeyPath', function () {
                return openProvider(provName, {
                    version: 1,
                    stores: [
                        {
                            name: 'test',
                            primaryKeyPath: 'id'
                        }
                    ]
                }).then(function (prov) {
                    // The indexeddb lib we're using for unit tests doesn't support range queries on the PK, so ignore those for now...
                    return tester(prov, null, false, function (obj, v) { obj.id = v; }, provName === 'indexeddbtest');
                });
            });
            it('Simple index put/get, getAll, getOnly, and getRange', function () {
                return openProvider(provName, {
                    version: 1,
                    stores: [
                        {
                            name: 'test',
                            primaryKeyPath: 'id',
                            indexes: [
                                {
                                    name: 'index',
                                    keyPath: 'a'
                                }
                            ]
                        }
                    ]
                }).then(function (prov) {
                    return tester(prov, 'index', false, function (obj, v) { obj.a = v; });
                });
            });
            it('Multipart primary key basic test', function () {
                return openProvider(provName, {
                    version: 1,
                    stores: [
                        {
                            name: 'test',
                            primaryKeyPath: 'a.b'
                        }
                    ]
                }).then(function (prov) {
                    // The indexeddb lib we're using for unit tests doesn't support range queries on the PK, so ignore those for now...
                    return tester(prov, null, false, function (obj, v) { obj.a = { b: v }; }, provName === 'indexeddbtest');
                });
            });
            it('Multipart index basic test', function () {
                return openProvider(provName, {
                    version: 1,
                    stores: [
                        {
                            name: 'test',
                            primaryKeyPath: 'id',
                            indexes: [
                                {
                                    name: 'index',
                                    keyPath: 'a.b'
                                }
                            ]
                        }
                    ]
                }).then(function (prov) {
                    return tester(prov, 'index', false, function (obj, v) { obj.a = { b: v }; });
                });
            });
            it('Compound primary key basic test', function () {
                return openProvider(provName, {
                    version: 1,
                    stores: [
                        {
                            name: 'test',
                            primaryKeyPath: ['a', 'b']
                        }
                    ]
                }).then(function (prov) {
                    return tester(prov, null, true, function (obj, v1, v2) { obj.a = v1; obj.b = v2; }, provName === 'indexeddbtest');
                });
            });
            it('Compound index basic test', function () {
                return openProvider(provName, {
                    version: 1,
                    stores: [
                        {
                            name: 'test',
                            primaryKeyPath: 'id',
                            indexes: [
                                {
                                    name: 'index',
                                    keyPath: ['a', 'b']
                                }
                            ]
                        }
                    ]
                }).then(function (prov) {
                    return tester(prov, 'index', true, function (obj, v1, v2) { obj.a = v1; obj.b = v2; });
                });
            });
            it('MultiEntry multipart indexed tests', function () {
                return openProvider(provName, {
                    version: 1,
                    stores: [
                        {
                            name: 'test',
                            primaryKeyPath: 'id',
                            indexes: [
                                {
                                    name: 'key',
                                    multiEntry: true,
                                    keyPath: 'k.k'
                                }
                            ]
                        }
                    ]
                }).then(function (prov) {
                    return prov.put('test', { id: 'a', val: 'b', k: { k: ['w', 'x', 'y', 'z'] } }).then(function () {
                        var g1 = prov.get('test', 'a').then(function (ret) {
                            assert.equal(ret.val, 'b');
                        });
                        var g2 = prov.getAll('test', 'key').then(function (ret) {
                            assert.equal(ret.length, 4);
                            ret.forEach(function (r) { assert.equal(r.val, 'b'); });
                        });
                        var g2b = (provName === 'indexeddbtest') ? null : prov.getAll('test', 'key', false, 2).then(function (ret) {
                            assert.equal(ret.length, 2);
                            ret.forEach(function (r) { assert.equal(r.val, 'b'); });
                        });
                        var g2c = (provName === 'indexeddbtest') ? null : prov.getAll('test', 'key', false, 2, 1).then(function (ret) {
                            assert.equal(ret.length, 2);
                            ret.forEach(function (r) { assert.equal(r.val, 'b'); });
                        });
                        var g3 = prov.getOnly('test', 'key', 'x').then(function (ret) {
                            assert.equal(ret.length, 1);
                            assert.equal(ret[0].val, 'b');
                        });
                        var g4 = prov.getRange('test', 'key', 'x', 'y', false, false).then(function (ret) {
                            assert.equal(ret.length, 2);
                            ret.forEach(function (r) { assert.equal(r.val, 'b'); });
                        });
                        return SyncTasks.whenAll([g1, g2, g2b, g2c, g3, g4]);
                    });
                });
            });
        });
    });
});
