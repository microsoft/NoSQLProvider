import assert = require('assert');
import _ = require('lodash');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('../NoSqlProvider');
import NoSqlProviderUtils = require('../NoSqlProviderUtils');

// Don't trap exceptions so we immediately see them with a stack trace
SyncTasks.config.catchExceptions = false;

function openProvider(providerName: string, schema: NoSqlProvider.DbSchema, wipeFirst: boolean) {
    let provider: NoSqlProvider.DbProvider = null;
    if (providerName === 'sqlite3test') {
        var sqlite3 = require('sqlite3');
        provider = new NoSqlProvider.NodeSqlite3MemoryDbProvider(sqlite3);
    } else if (providerName === 'indexeddbtest') {
        var sqlite3 = require('sqlite3');
        const engine = new sqlite3.Database(':memory:');
        var indexeddbjs = require('indexeddb-js');
        const scope = indexeddbjs.makeScope('sqlite3', engine);
        global['IDBKeyRange'] = scope.IDBKeyRange;

        const idbFactory = scope.indexedDB;
        provider = new NoSqlProvider.IndexedDbProvider(idbFactory, false);
    } else if (providerName === 'memory') {
        provider = new NoSqlProvider.InMemoryProvider();
    } else if (providerName === 'indexeddb') {
        provider = new NoSqlProvider.IndexedDbProvider();
    } else if (providerName === 'indexeddbfakekeys') {
        provider = new NoSqlProvider.IndexedDbProvider(void 0, false);
    } else if (providerName === 'websql') {
        provider = new NoSqlProvider.WebSqlProvider();
    }
    return NoSqlProvider.openListOfProviders([provider], 'test', schema, wipeFirst);
}

describe('NoSqlProvider', function () {
    this.timeout(30000);

    let provsToTest = typeof window === 'undefined' ? ['sqlite3test', 'indexeddbtest', 'memory'] : NoSqlProviderUtils.isIE() ? ['indexeddb'] : ['indexeddb', 'indexeddbfakekeys', 'websql'];

    it('Number/value/type sorting', () => {
        const pairsToTest = [
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

        pairsToTest.forEach(pair => {
            assert(NoSqlProviderUtils.serializeValueToOrderableString(pair[0]) <
                NoSqlProviderUtils.serializeValueToOrderableString(pair[1]), 'failed for pair: ' + pair);
        });

        try {
            NoSqlProviderUtils.serializeValueToOrderableString([4, 5]);
            assert(false, 'Should reject this key');
        } catch (e) {
            // Should throw -- expecting this result.
        }
    });

    provsToTest.forEach(provName => {
        describe('Provider: ' + provName, () => {
            describe('Data Manipulation', () => {
                // Setter should set the testable parameter on the first param to the value in the second param, and third param to the
                // second index column for compound indexes.
                var tester = (prov: NoSqlProvider.DbProvider, indexName: string, compound: boolean,
                    setter: (obj: any, indexval1: string, indexval2: string) => void, noRange: boolean = false) => {
                    var putters = [1, 2, 3, 4, 5].map(v => {
                        var obj: any = { val: 'val' + v };
                        if (indexName) {
                            obj.id = 'id' + v;
                        }
                        setter(obj, 'indexa' + v, 'indexb' + v);
                        return prov.put('test', obj);
                    });

                    return SyncTasks.whenAll(putters).then(rets => {
                        let formIndex = (i: number, i2: number = i): string | string[] => {
                            if (compound) {
                                return ['indexa' + i, 'indexb' + i2];
                            } else {
                                return 'indexa' + i;
                            }
                        };

                        let t1 = prov.getAll<any>('test', indexName).then(ret => {
                            assert.equal(ret.length, 5, 'getAll');
                            [1, 2, 3, 4, 5].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v), 'cant find ' + v); });
                        });

                        let t1b = (provName === 'indexeddbtest') ? null : prov.getAll<any>('test', indexName, false, 3).then(ret => {
                            assert.equal(ret.length, 3, 'getAll lim3');
                            [1, 2, 3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v), 'cant find ' + v); });
                        });

                        let t1c = (provName === 'indexeddbtest') ? null : prov.getAll<any>('test', indexName, false, 3, 1).then(ret => {
                            assert.equal(ret.length, 3, 'getAll lim3 off1');
                            [2, 3, 4].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v), 'cant find ' + v); });
                        });

                        let t2 = noRange ? null : prov.getOnly<any>('test', indexName, formIndex(3)).then(ret => {
                            assert.equal(ret.length, 1, 'getOnly');
                            assert.equal(ret[0].val, 'val3');
                        });

                        let t3 = noRange ? null : prov.getRange<any>('test', indexName, formIndex(2), formIndex(4)).then(ret => {
                            assert.equal(ret.length, 3, 'getRange++');
                            [2, 3, 4].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                        });

                        let t3b = (noRange || provName === 'indexeddbtest') ? null :
                            prov.getRange<any>('test', indexName, formIndex(2), formIndex(4), false, false, false, 1).then(ret => {
                                assert.equal(ret.length, 1, 'getRange++ lim1');
                                [2].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3b2 = (noRange || provName === 'indexeddbtest') ? null :
                            prov.getRange<any>('test', indexName, formIndex(2), formIndex(4), false, false, true, 1).then(ret => {
                                assert.equal(ret.length, 1, 'getRange++ lim1 rev');
                                [4].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3c = (noRange || provName === 'indexeddbtest') ? null :
                            prov.getRange<any>('test', indexName, formIndex(2), formIndex(4), false, false, false, 1, 1).then(ret => {
                                assert.equal(ret.length, 1, 'getRange++ lim1 off1');
                                [3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3d = (noRange || provName === 'indexeddbtest') ? null :
                            prov.getRange<any>('test', indexName, formIndex(2), formIndex(4), false, false, false, 2, 1).then(ret => {
                                assert.equal(ret.length, 2, 'getRange++ lim2 off1');
                                [3, 4].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3d2 = (noRange || provName === 'indexeddbtest') ? null :
                            prov.getRange<any>('test', indexName, formIndex(2), formIndex(4), false, false, true, 2, 1).then(ret => {
                                assert.equal(ret.length, 2, 'getRange++ lim2 off1 rev');
                                assert.equal(ret[0].val, 'val3');
                                [2, 3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                            });

                        let t4 = noRange ? null : prov.getRange<any>('test', indexName, formIndex(2), formIndex(4), true, false).then(ret => {
                            assert.equal(ret.length, 2, 'getRange-+');
                            [3, 4].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                        });

                        let t5 = noRange ? null : prov.getRange<any>('test', indexName, formIndex(2), formIndex(4), false, true).then(ret => {
                            assert.equal(ret.length, 2, 'getRange+-');
                            [2, 3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                        });

                        let t6 = noRange ? null : prov.getRange<any>('test', indexName, formIndex(2), formIndex(4), true, true).then(ret => {
                            assert.equal(ret.length, 1, 'getRange--');
                            [3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                        });

                        return SyncTasks.whenAll([t1, t1b, t1c, t2, t3, t3b, t3b2, t3c, t3d, t3d2, t4, t5, t6]).then(() => {
                            if (compound) {
                                let tt1 = noRange ? null : prov.getRange<any>('test', indexName, formIndex(2, 2), formIndex(4, 3))
                                    .then(ret => {
                                        assert.equal(ret.length, 2, 'getRange2++');
                                        [2, 3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                                    });

                                let tt2 = noRange ? null : prov.getRange<any>('test', indexName, formIndex(2, 2), formIndex(4, 3), false, true)
                                    .then(ret => {
                                        assert.equal(ret.length, 2, 'getRange2+-');
                                        [2, 3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                                    });

                                let tt3 = noRange ? null : prov.getRange<any>('test', indexName, formIndex(2, 2), formIndex(4, 3), true, false)
                                    .then(ret => {
                                        assert.equal(ret.length, 1, 'getRange2-+');
                                        [3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                                    });

                                return SyncTasks.whenAll([tt1, tt2, tt3]).then(() => {
                                    return prov.close();
                                });
                            } else {
                                return prov.close();
                            }
                        });
                    });
                };

                it('Simple primary key put/get/getAll', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(prov => {
                        return prov.put('test', { id: 'a', val: 'b' }).then(() => {
                            return prov.get<any>('test', 'a').then(ret => {
                                assert.equal(ret.val, 'b');

                                return prov.getAll<any>('test').then(ret2 => {
                                    assert.equal(ret2.length, 1);
                                    assert.equal(ret2[0].val, 'b');

                                    return prov.close();
                                });
                            });
                        });
                    });
                });

                it('Primary Key Basic KeyPath', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(prov => {
                        // The indexeddb lib we're using for unit tests doesn't support range queries on the PK, so ignore those for now...
                        return tester(prov, null, false, (obj, v) => { obj.id = v; }, provName === 'indexeddbtest');
                    });
                });

                it('Simple index put/get, getAll, getOnly, and getRange', () => {
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
                    }, true).then(prov => {
                        return tester(prov, 'index', false, (obj, v) => { obj.a = v; });
                    });
                });

                it('Multipart primary key basic test', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'a.b'
                            }
                        ]
                    }, true).then(prov => {
                        // The indexeddb lib we're using for unit tests doesn't support range queries on the PK, so ignore those for now...
                        return tester(prov, null, false, (obj, v) => { obj.a = { b: v }; }, provName === 'indexeddbtest');
                    });
                });

                it('Multipart index basic test', () => {
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
                    }, true).then(prov => {
                        return tester(prov, 'index', false, (obj, v) => { obj.a = { b: v }; });
                    });
                });

                it('Compound primary key basic test', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: ['a', 'b']
                            }
                        ]
                    }, true).then(prov => {
                        return tester(prov, null, true, (obj, v1, v2) => { obj.a = v1; obj.b = v2; }, provName === 'indexeddbtest');
                    });
                });

                it('Compound index basic test', () => {
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
                    }, true).then(prov => {
                        return tester(prov, 'index', true, (obj, v1, v2) => { obj.a = v1; obj.b = v2; });
                    });
                });

                it('MultiEntry multipart indexed tests', () => {
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
                    }, true).then(prov => {
                        return prov.put('test', { id: 'a', val: 'b', k: { k: ['w', 'x', 'y', 'z'] } }).then(() => {
                            var g1 = prov.get<any>('test', 'a').then(ret => {
                                assert.equal(ret.val, 'b');
                            });
                            var g2 = prov.getAll<any>('test', 'key').then(ret => {
                                assert.equal(ret.length, 4);
                                ret.forEach(r => { assert.equal(r.val, 'b'); });
                            });
                            var g2b = (provName === 'indexeddbtest') ? null : prov.getAll<any>('test', 'key', false, 2).then(ret => {
                                assert.equal(ret.length, 2);
                                ret.forEach(r => { assert.equal(r.val, 'b'); });
                            });
                            var g2c = (provName === 'indexeddbtest') ? null : prov.getAll<any>('test', 'key', false, 2, 1).then(ret => {
                                assert.equal(ret.length, 2);
                                ret.forEach(r => { assert.equal(r.val, 'b'); });
                            });
                            var g3 = prov.getOnly<any>('test', 'key', 'x').then(ret => {
                                assert.equal(ret.length, 1);
                                assert.equal(ret[0].val, 'b');
                            });
                            var g4 = prov.getRange<any>('test', 'key', 'x', 'y', false, false).then(ret => {
                                assert.equal(ret.length, 2);
                                ret.forEach(r => { assert.equal(r.val, 'b'); });
                            });
                            return SyncTasks.whenAll([g1, g2, g2b, g2c, g3, g4]).then(() => {
                                return prov.close();
                            });
                        });
                    });
                });
            });

            describe('Schema Upgrades', () => {
                it('Basic schema upgrade path', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(prov => {
                        return prov.put('test', { id: 'abc' }).then(() => {
                            return prov.close();
                        });
                    }).then(() => {
                        return openProvider(provName, {
                            version: 2,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, false).then(prov => {
                            return prov.get('test', 'abc').then(item => {
                                assert(!!item);
                                return prov.close();
                            });
                        });
                    });
                });

                it('Removing old store then accessing it', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(prov => {
                        return prov.put('test', { id: 'abc' }).then(() => {
                            return prov.close();
                        });
                    }).then(() => {
                        return openProvider(provName, {
                            version: 2,
                            stores: [
                                {
                                    name: 'test2',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, false).then(prov => {
                            return prov.get('test', 'abc').then(item => {
                                return prov.close().then(() => {
                                    return SyncTasks.Rejected<void>('Shouldn\'t have worked');
                                });
                            }, () => {
                                // Expected to fail, so chain from failure to success
                                return prov.close();
                            });
                        });
                    });
                });

                it('Opening an older DB version', () => {
                    return openProvider(provName, {
                        version: 2,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(prov => {
                        return prov.close();
                    }).then(() => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test2',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, false).then(prov => {
                            return prov.get('test', 'abc').then(item => {
                                return prov.close().then(() => {
                                    return SyncTasks.Rejected<void>('Shouldn\'t have worked');
                                });
                            }, () => {
                                // Expected to fail, so chain from failure to success
                                return prov.close();
                            });
                        });
                    });
                });
            });
        });
    });
});
