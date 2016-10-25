"use strict";
var assert = require('assert');
var _ = require('lodash');
var SyncTasks = require('synctasks');
var NoSqlProvider = require('../NoSqlProvider');
var InMemoryProvider_1 = require('../InMemoryProvider');
var IndexedDbProvider_1 = require('../IndexedDbProvider');
var WebSqlProvider_1 = require('../WebSqlProvider');
var NoSqlProviderUtils = require('../NoSqlProviderUtils');
// Don't trap exceptions so we immediately see them with a stack trace
SyncTasks.config.catchExceptions = false;
function openProvider(providerName, schema, wipeFirst) {
    var provider = null;
    if (providerName === 'sqlite3memory') {
        var NSPNodeSqlite3MemoryDbProvider = require('../NodeSqlite3MemoryDbProvider');
        provider = new NSPNodeSqlite3MemoryDbProvider.NodeSqlite3MemoryDbProvider();
    }
    else if (providerName === 'memory') {
        provider = new InMemoryProvider_1.InMemoryProvider();
    }
    else if (providerName === 'indexeddb') {
        provider = new IndexedDbProvider_1.IndexedDbProvider();
    }
    else if (providerName === 'indexeddbfakekeys') {
        provider = new IndexedDbProvider_1.IndexedDbProvider(void 0, false);
    }
    else if (providerName === 'websql') {
        provider = new WebSqlProvider_1.WebSqlProvider();
    }
    return NoSqlProvider.openListOfProviders([provider], 'test', schema, wipeFirst, false);
}
describe('NoSqlProvider', function () {
    //this.timeout(30000);
    var provsToTest = typeof window === 'undefined' ? ['sqlite3memory', 'memory'] : NoSqlProviderUtils.isIE() ? ['indexeddb', 'memory'] : ['indexeddb', 'indexeddbfakekeys', 'websql', 'memory'];
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
            describe('Data Manipulation', function () {
                // Setter should set the testable parameter on the first param to the value in the second param, and third param to the
                // second index column for compound indexes.
                var tester = function (prov, indexName, compound, setter) {
                    var putters = [1, 2, 3, 4, 5].map(function (v) {
                        var obj = { val: 'val' + v };
                        if (indexName) {
                            obj.id = 'id' + v;
                        }
                        setter(obj, 'indexa' + v, 'indexb' + v);
                        return prov.put('test', obj);
                    });
                    return SyncTasks.all(putters).then(function (rets) {
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
                        var t1b = prov.getAll('test', indexName, false, 3).then(function (ret) {
                            assert.equal(ret.length, 3, 'getAll lim3');
                            [1, 2, 3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; }), 'cant find ' + v); });
                        });
                        var t1c = prov.getAll('test', indexName, false, 3, 1).then(function (ret) {
                            assert.equal(ret.length, 3, 'getAll lim3 off1');
                            [2, 3, 4].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; }), 'cant find ' + v); });
                        });
                        var t2 = prov.getOnly('test', indexName, formIndex(3)).then(function (ret) {
                            assert.equal(ret.length, 1, 'getOnly');
                            assert.equal(ret[0].val, 'val3');
                        });
                        var t3 = prov.getRange('test', indexName, formIndex(2), formIndex(4)).then(function (ret) {
                            assert.equal(ret.length, 3, 'getRange++');
                            [2, 3, 4].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                        var t3b = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 1).then(function (ret) {
                            assert.equal(ret.length, 1, 'getRange++ lim1');
                            [2].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                        var t3b2 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, true, 1).then(function (ret) {
                            assert.equal(ret.length, 1, 'getRange++ lim1 rev');
                            [4].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                        var t3c = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 1, 1).then(function (ret) {
                            assert.equal(ret.length, 1, 'getRange++ lim1 off1');
                            [3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                        var t3d = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 2, 1).then(function (ret) {
                            assert.equal(ret.length, 2, 'getRange++ lim2 off1');
                            [3, 4].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                        var t3d2 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, true, 2, 1).then(function (ret) {
                            assert.equal(ret.length, 2, 'getRange++ lim2 off1 rev');
                            assert.equal(ret[0].val, 'val3');
                            [2, 3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                        var t4 = prov.getRange('test', indexName, formIndex(2), formIndex(4), true, false).then(function (ret) {
                            assert.equal(ret.length, 2, 'getRange-+');
                            [3, 4].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                        var t5 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, true).then(function (ret) {
                            assert.equal(ret.length, 2, 'getRange+-');
                            [2, 3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                        var t6 = prov.getRange('test', indexName, formIndex(2), formIndex(4), true, true).then(function (ret) {
                            assert.equal(ret.length, 1, 'getRange--');
                            [3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                        });
                        return SyncTasks.all([t1, t1b, t1c, t2, t3, t3b, t3b2, t3c, t3d, t3d2, t4, t5, t6]).then(function () {
                            if (compound) {
                                var tt1 = prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3))
                                    .then(function (ret) {
                                    assert.equal(ret.length, 2, 'getRange2++');
                                    [2, 3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                                });
                                var tt2 = prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3), false, true)
                                    .then(function (ret) {
                                    assert.equal(ret.length, 2, 'getRange2+-');
                                    [2, 3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                                });
                                var tt3 = prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3), true, false)
                                    .then(function (ret) {
                                    assert.equal(ret.length, 1, 'getRange2-+');
                                    [3].forEach(function (v) { assert(_.find(ret, function (r) { return r.val === 'val' + v; })); });
                                });
                                return SyncTasks.all([tt1, tt2, tt3]).then(function () {
                                    return prov.close();
                                });
                            }
                            else {
                                return prov.close();
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
                    }, true).then(function (prov) {
                        return prov.put('test', { id: 'a', val: 'b' }).then(function () {
                            return prov.get('test', 'a').then(function (ret) {
                                assert.equal(ret.val, 'b');
                                return prov.getAll('test').then(function (ret2) {
                                    assert.equal(ret2.length, 1);
                                    assert.equal(ret2[0].val, 'b');
                                    return prov.close();
                                });
                            });
                        });
                    });
                });
                it('Empty gets/puts', function () {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(function (prov) {
                        return prov.put('test', []).then(function () {
                            return prov.getAll('test').then(function (rets) {
                                assert(!!rets);
                                assert.equal(rets.length, 0);
                                return prov.getMultiple('test', []).then(function (rets) {
                                    assert(!!rets);
                                    assert.equal(rets.length, 0);
                                    return prov.close();
                                });
                            });
                        });
                    });
                });
                it('Removing items', function () {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(function (prov) {
                        return prov.put('test', [1, 2, 3, 4, 5].map(function (i) { return { id: 'a' + i }; })).then(function () {
                            return prov.getAll('test').then(function (rets) {
                                assert(!!rets);
                                assert.equal(rets.length, 5);
                                return prov.remove('test', 'a1').then(function () {
                                    return prov.getAll('test').then(function (rets) {
                                        assert(!!rets);
                                        assert.equal(rets.length, 4);
                                        return prov.remove('test', ['a3', 'a4', 'a2']).then(function () {
                                            return prov.getAll('test').then(function (rets) {
                                                assert(!!rets);
                                                assert.equal(rets.length, 1);
                                                assert.equal(rets[0].id, 'a5');
                                                return prov.close();
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
                it('Invalid Key Type', function () {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(function (prov) {
                        var oldCatchMode = SyncTasks.config.catchExceptions;
                        SyncTasks.config.catchExceptions = true;
                        return prov.put('test', { id: { x: 'a' }, val: 'b' }).then(function () {
                            assert(false, 'Shouldn\'t get here');
                        }, function (err) {
                            // Woot, failed like it's supposed to
                            SyncTasks.config.catchExceptions = oldCatchMode;
                            return prov.close();
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
                    }, true).then(function (prov) {
                        return tester(prov, null, false, function (obj, v) { obj.id = v; });
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
                    }, true).then(function (prov) {
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
                    }, true).then(function (prov) {
                        return tester(prov, null, false, function (obj, v) { obj.a = { b: v }; });
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
                    }, true).then(function (prov) {
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
                    }, true).then(function (prov) {
                        return tester(prov, null, true, function (obj, v1, v2) { obj.a = v1; obj.b = v2; });
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
                    }, true).then(function (prov) {
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
                    }, true).then(function (prov) {
                        return prov.put('test', { id: 'a', val: 'b', k: { k: ['w', 'x', 'y', 'z'] } }).then(function () {
                            var g1 = prov.get('test', 'a').then(function (ret) {
                                assert.equal(ret.val, 'b');
                            });
                            var g2 = prov.getAll('test', 'key').then(function (ret) {
                                assert.equal(ret.length, 4);
                                ret.forEach(function (r) { assert.equal(r.val, 'b'); });
                            });
                            var g2b = prov.getAll('test', 'key', false, 2).then(function (ret) {
                                assert.equal(ret.length, 2);
                                ret.forEach(function (r) { assert.equal(r.val, 'b'); });
                            });
                            var g2c = prov.getAll('test', 'key', false, 2, 1).then(function (ret) {
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
                            return SyncTasks.all([g1, g2, g2b, g2c, g3, g4]).then(function () {
                                return prov.close();
                            });
                        });
                    });
                });
            });
            if (provName !== 'memory' && provName !== 'sqlite3memory') {
                describe('Schema Upgrades', function () {
                    it('Opening an older DB version', function () {
                        return openProvider(provName, {
                            version: 2,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, true).then(function (prov) {
                            return prov.close();
                        }).then(function () {
                            return openProvider(provName, {
                                version: 1,
                                stores: [
                                    {
                                        name: 'test2',
                                        primaryKeyPath: 'id'
                                    }
                                ]
                            }, false).then(function (prov) {
                                return prov.get('test', 'abc').then(function (item) {
                                    return prov.close().then(function () {
                                        return SyncTasks.Rejected('Shouldn\'t have worked');
                                    });
                                }, function () {
                                    // Expected to fail, so chain from failure to success
                                    return prov.close();
                                });
                            });
                        });
                    });
                    it('Basic NOOP schema upgrade path', function () {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, true).then(function (prov) {
                            return prov.put('test', { id: 'abc' }).then(function () {
                                return prov.close();
                            });
                        }).then(function () {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id'
                                    }
                                ]
                            }, false).then(function (prov) {
                                return prov.get('test', 'abc').then(function (item) {
                                    assert(!!item);
                                    return prov.close();
                                });
                            });
                        });
                    });
                    it('Adding new store', function () {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, true).then(function (prov) {
                            return prov.put('test', { id: 'abc' }).then(function () {
                                return prov.close();
                            });
                        }).then(function () {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id'
                                    },
                                    {
                                        name: 'test2',
                                        primaryKeyPath: 'ttt'
                                    }
                                ]
                            }, false).then(function (prov) {
                                return prov.put('test2', { id: 'def', ttt: 'ghi' }).then(function () {
                                    var p1 = prov.get('test', 'abc').then(function (item) {
                                        assert(!!item);
                                        assert.equal(item.id, 'abc');
                                    });
                                    var p2 = prov.get('test2', 'abc').then(function (item) {
                                        assert(!item);
                                    });
                                    var p3 = prov.get('test2', 'def').then(function (item) {
                                        assert(!item);
                                    });
                                    var p4 = prov.get('test2', 'ghi').then(function (item) {
                                        assert(!!item);
                                        assert.equal(item.id, 'def');
                                    });
                                    return SyncTasks.all([p1, p2, p3, p4]).then(function () {
                                        return prov.close();
                                    });
                                });
                            });
                        });
                    });
                    it('Removing old store', function () {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, true).then(function (prov) {
                            return prov.put('test', { id: 'abc' }).then(function () {
                                return prov.close();
                            });
                        }).then(function () {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test2',
                                        primaryKeyPath: 'id'
                                    }
                                ]
                            }, false).then(function (prov) {
                                return prov.get('test', 'abc').then(function (item) {
                                    return prov.close().then(function () {
                                        return SyncTasks.Rejected('Shouldn\'t have worked');
                                    });
                                }, function () {
                                    // Expected to fail, so chain from failure to success
                                    return prov.close();
                                });
                            });
                        });
                    });
                    it('Add index', function () {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, true).then(function (prov) {
                            return prov.put('test', { id: 'abc', tt: 'a' }).then(function () {
                                return prov.close();
                            });
                        }).then(function () {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [{
                                                name: 'ind1',
                                                keyPath: 'tt'
                                            }]
                                    }
                                ]
                            }, false).then(function (prov) {
                                var p1 = prov.getOnly('test', 'ind1', 'a').then(function (items) {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                    assert.equal(items[0].tt, 'a');
                                });
                                var p2 = prov.getOnly('test', null, 'abc').then(function (items) {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                    assert.equal(items[0].tt, 'a');
                                });
                                var p3 = prov.getOnly('test', 'ind1', 'abc').then(function (items) {
                                    assert.equal(items.length, 0);
                                });
                                return SyncTasks.all([p1, p2, p3]).then(function () {
                                    return prov.close();
                                });
                            });
                        });
                    });
                    it('Removing old index', function () {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id',
                                    indexes: [{
                                            name: 'ind1',
                                            keyPath: 'tt'
                                        }]
                                }
                            ]
                        }, true).then(function (prov) {
                            return prov.put('test', { id: 'abc', tt: 'a' }).then(function () {
                                return prov.close();
                            });
                        }).then(function () {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id'
                                    }
                                ]
                            }, false).then(function (prov) {
                                return prov.getOnly('test', 'ind1', 'a').then(function (items) {
                                    return prov.close().then(function () {
                                        return SyncTasks.Rejected('Shouldn\'t have worked');
                                    });
                                }, function () {
                                    // Expected to fail, so chain from failure to success
                                    return prov.close();
                                });
                            });
                        });
                    });
                    it('Changing index keypath', function () {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id',
                                    indexes: [{
                                            name: 'ind1',
                                            keyPath: 'tt'
                                        }]
                                }
                            ]
                        }, true).then(function (prov) {
                            return prov.put('test', { id: 'abc', tt: 'a', ttb: 'b' }).then(function () {
                                return prov.close();
                            });
                        }).then(function () {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [{
                                                name: 'ind1',
                                                keyPath: 'ttb'
                                            }]
                                    }
                                ]
                            }, false).then(function (prov) {
                                var p1 = prov.getOnly('test', 'ind1', 'a').then(function (items) {
                                    assert.equal(items.length, 0);
                                });
                                var p2 = prov.getOnly('test', 'ind1', 'b').then(function (items) {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].ttb, 'b');
                                });
                                var p3 = prov.getOnly('test', 'ind1', 'abc').then(function (items) {
                                    assert.equal(items.length, 0);
                                });
                                return SyncTasks.all([p1, p2, p3]).then(function () {
                                    return prov.close();
                                });
                            });
                        });
                    });
                });
            }
        });
    });
});
