import assert = require('assert');
import _ = require('lodash');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('../NoSqlProvider');
import { KeyComponentType } from '../NoSqlProvider';

// import { CordovaNativeSqliteProvider } from '../CordovaNativeSqliteProvider';
import { InMemoryProvider } from '../InMemoryProvider';
import { IndexedDbProvider } from '../IndexedDbProvider';
import { WebSqlProvider } from '../WebSqlProvider';

import NoSqlProviderUtils = require('../NoSqlProviderUtils');

// Don't trap exceptions so we immediately see them with a stack trace
SyncTasks.config.catchExceptions = false;

let cleanupFile = false;

type TestObj = { id?: string, val: string };

function openProvider(providerName: string, schema: NoSqlProvider.DbSchema, wipeFirst: boolean) {
    let provider: NoSqlProvider.DbProvider;
    if (providerName === 'sqlite3memory') {
        const NSPNodeSqlite3DbProvider = require('../NodeSqlite3DbProvider');
        provider = new NSPNodeSqlite3DbProvider.default();
    } else if (providerName === 'sqlite3memorynofts3') {
        const NSPNodeSqlite3DbProvider = require('../NodeSqlite3DbProvider');
        provider = new NSPNodeSqlite3DbProvider.default(false);
    } else if (providerName === 'sqlite3disk') {
        cleanupFile = true;
        const NSPNodeSqlite3DbProvider = require('../NodeSqlite3DbProvider');
        provider = new NSPNodeSqlite3DbProvider.default();
    } else if (providerName === 'sqlite3disknofts3') {
        cleanupFile = true;
        const NSPNodeSqlite3DbProvider = require('../NodeSqlite3DbProvider');
        provider = new NSPNodeSqlite3DbProvider.default(false);
    } else if (providerName === 'memory') {
        provider = new InMemoryProvider();
    } else if (providerName === 'indexeddb') {
        provider = new IndexedDbProvider();
    } else if (providerName === 'indexeddbfakekeys') {
        provider = new IndexedDbProvider(undefined, false);
    } else if (providerName === 'websql') {
        provider = new WebSqlProvider();
    } else if (providerName === 'websqlnofts3') {
        provider = new WebSqlProvider(false);
    // } else if (providerName === 'reactnative') {
    //     var reactNativeSqliteProvider = require('react-native-sqlite-storage');
    //     provider = new CordovaNativeSqliteProvider(reactNativeSqliteProvider);
    } else {
        throw new Error('Provider not found for name: ' + providerName);
    }
    const dbName = providerName.indexOf('sqlite3memory') !== -1 ? ':memory:' : 'test';
    return NoSqlProvider.openListOfProviders([provider], dbName, schema, wipeFirst, false);
}

function sleep(timeMs: number): SyncTasks.Promise<void> {
    let defer = SyncTasks.Defer<void>();
    setTimeout(() => { defer.resolve(); }, timeMs);
    return defer.promise();
}

describe('NoSqlProvider', function () {
    //this.timeout(60000);
    after(() => {
        if (cleanupFile) {
            var fs = require('fs');
            fs.unlink('test');
        }
    });

    const provsToTest = typeof window === 'undefined' ?
        ['sqlite3memory', 'sqlite3memorynofts3', 'sqlite3disk', 'sqlite3disknofts3', 'memory'] :
        (NoSqlProviderUtils.isIE() ? ['indexeddb', 'memory'] : ['indexeddb', 'indexeddbfakekeys', 'websql', 'websqlnofts3', 'memory']);

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
            NoSqlProviderUtils.serializeValueToOrderableString([4, 5] as any as KeyComponentType);
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
                var tester = (prov: NoSqlProvider.DbProvider, indexName: string|undefined, compound: boolean,
                        setter: (obj: any, indexval1: string, indexval2: string) => void) => {
                    var putters = [1, 2, 3, 4, 5].map(v => {
                        var obj: TestObj = { val: 'val' + v };
                        if (indexName) {
                            obj.id = 'id' + v;
                        }
                        setter(obj, 'indexa' + v, 'indexb' + v);
                        return prov.put('test', obj);
                    });

                    return SyncTasks.all(putters).then(rets => {
                        let formIndex = (i: number, i2: number = i): string | string[] => {
                            if (compound) {
                                return ['indexa' + i, 'indexb' + i2];
                            } else {
                                return 'indexa' + i;
                            }
                        };

                        let t1 = prov.getAll('test', indexName).then((ret: TestObj[]) => {
                            assert.equal(ret.length, 5, 'getAll');
                            [1, 2, 3, 4, 5].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v), 'cant find ' + v); });
                        });

                        let t1count = prov.countAll('test', indexName).then(ret => {
                            assert.equal(ret, 5, 'countAll');
                        });

                        let t1b = prov.getAll('test', indexName, false, 3).then((ret: TestObj[]) => {
                            assert.equal(ret.length, 3, 'getAll lim3');
                            [1, 2, 3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v), 'cant find ' + v); });
                        });

                        let t1c = prov.getAll('test', indexName, false, 3, 1).then((ret: TestObj[]) => {
                            assert.equal(ret.length, 3, 'getAll lim3 off1');
                            [2, 3, 4].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v), 'cant find ' + v); });
                        });

                        let t2 = prov.getOnly('test', indexName, formIndex(3)).then((ret: TestObj[]) => {
                            assert.equal(ret.length, 1, 'getOnly');
                            assert.equal(ret[0].val, 'val3');
                        });

                        let t2count = prov.countOnly('test', indexName, formIndex(3)).then(ret => {
                            assert.equal(ret, 1, 'countOnly');
                        });

                        let t3 = prov.getRange('test', indexName, formIndex(2), formIndex(4)).then((ret: TestObj[]) => {
                            assert.equal(ret.length, 3, 'getRange++');
                            [2, 3, 4].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                        });

                        let t3count = prov.countRange('test', indexName, formIndex(2), formIndex(4)).then(ret => {
                            assert.equal(ret, 3, 'countRange++');
                        });

                        let t3b = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 1)
                            .then((ret: TestObj[]) => {
                                assert.equal(ret.length, 1, 'getRange++ lim1');
                                [2].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3b2 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, true, 1)
                            .then((ret: TestObj[]) => {
                                assert.equal(ret.length, 1, 'getRange++ lim1 rev');
                                [4].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3c = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 1, 1)
                            .then((ret: TestObj[]) => {
                                assert.equal(ret.length, 1, 'getRange++ lim1 off1');
                                [3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3d = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 2, 1)
                            .then((ret: TestObj[]) => {
                                assert.equal(ret.length, 2, 'getRange++ lim2 off1');
                                [3, 4].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3d2 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, true, 2, 1)
                            .then((ret: TestObj[]) => {
                                assert.equal(ret.length, 2, 'getRange++ lim2 off1 rev');
                                assert.equal(ret[0].val, 'val3');
                                [2, 3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                            });

                        let t4 = prov.getRange('test', indexName, formIndex(2), formIndex(4), true, false).then((ret: TestObj[]) => {
                            assert.equal(ret.length, 2, 'getRange-+');
                            [3, 4].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                        });

                        let t4count = prov.countRange('test', indexName, formIndex(2), formIndex(4), true, false).then(ret => {
                            assert.equal(ret, 2, 'countRange-+');
                        });

                        let t5 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, true).then((ret: TestObj[]) => {
                            assert.equal(ret.length, 2, 'getRange+-');
                            [2, 3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                        });

                        let t5count = prov.countRange('test', indexName, formIndex(2), formIndex(4), false, true).then(ret => {
                            assert.equal(ret, 2, 'countRange+-');
                        });

                        let t6 = prov.getRange('test', indexName, formIndex(2), formIndex(4), true, true).then((ret: TestObj[]) => {
                            assert.equal(ret.length, 1, 'getRange--');
                            [3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                        });

                        let t6count = prov.countRange('test', indexName, formIndex(2), formIndex(4), true, true).then(ret => {
                            assert.equal(ret, 1, 'countRange--');
                        });

                        return SyncTasks.all([t1, t1count, t1b, t1c, t2, t2count, t3, t3count, t3b, t3b2, t3c, t3d, t3d2, t4, t4count, t5,
                                t5count, t6, t6count]).then(() => {
                            if (compound) {
                                let tt1 = prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3))
                                    .then((ret: TestObj[]) => {
                                        assert.equal(ret.length, 2, 'getRange2++');
                                        [2, 3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                                    });

                                let tt1count = prov.countRange('test', indexName, formIndex(2, 2), formIndex(4, 3))
                                    .then(ret => {
                                        assert.equal(ret, 2, 'countRange2++');
                                    });

                                let tt2 = prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3), false, true)
                                    .then((ret: TestObj[]) => {
                                        assert.equal(ret.length, 2, 'getRange2+-');
                                        [2, 3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                                    });

                                let tt2count = prov.countRange('test', indexName, formIndex(2, 2), formIndex(4, 3), false, true)
                                    .then(ret => {
                                        assert.equal(ret, 2, 'countRange2+-');
                                    });

                                let tt3 = prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3), true, false)
                                    .then((ret: TestObj[]) => {
                                        assert.equal(ret.length, 1, 'getRange2-+');
                                        [3].forEach(v => { assert(_.find(ret, r => r.val === 'val' + v)); });
                                    });

                                let tt3count = prov.countRange('test', indexName, formIndex(2, 2), formIndex(4, 3), true, false)
                                    .then(ret => {
                                        assert.equal(ret, 1, 'countRange2-+');
                                    });

                                return SyncTasks.all([tt1, tt1count, tt2, tt2count, tt3, tt3count]).then(() => {
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
                            return prov.get('test', 'a').then((ret: TestObj) => {
                                assert.equal(ret.val, 'b');

                                return prov.getAll('test', undefined).then((ret2: TestObj[]) => {
                                    assert.equal(ret2.length, 1);
                                    assert.equal(ret2[0].val, 'b');

                                    return prov.close();
                                });
                            });
                        });
                    });
                });

                it('Empty gets/puts', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(prov => {
                        return prov.put('test', []).then(() => {
                            return prov.getAll('test', undefined).then(rets => {
                                assert(!!rets);
                                assert.equal(rets.length, 0);
                                return prov.getMultiple('test', []).then(rets => {
                                    assert(!!rets);
                                    assert.equal(rets.length, 0);
                                    return prov.close();
                                });
                            });
                        });
                    });
                });

                it('getMultiple with blank', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(prov => {
                        return prov.put('test', [1, 3].map(i => { return { id: 'a' + i }; })).then(() => {
                            return prov.getMultiple('test', ['a1', 'a2', 'a3']).then(rets => {
                                assert(!!rets);
                                assert.equal(rets.length, 2);
                                return prov.close();
                            });
                        });
                    });
                });

                it('Removing items', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(prov => {
                        return prov.put('test', [1, 2, 3, 4, 5].map(i => { return { id: 'a' + i }; })).then(() => {
                            return prov.getAll('test', undefined).then(rets => {
                                assert(!!rets);
                                assert.equal(rets.length, 5);
                                return prov.remove('test', 'a1').then(() => {
                                    return prov.getAll('test', undefined).then(rets => {
                                        assert(!!rets);
                                        assert.equal(rets.length, 4);
                                        return prov.remove('test', ['a3', 'a4', 'a2']).then(() => {
                                            return prov.getAll('test', undefined).then((rets: TestObj[]) => {
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

                it('Invalid Key Type', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: 'id'
                            }
                        ]
                    }, true).then(prov => {
                        return prov.put('test', { id: { x: 'a' }, val: 'b' }).then(() => {
                            assert(false, 'Shouldn\'t get here');
                        }, (err) => {
                            // Woot, failed like it's supposed to
                            return prov.close();
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
                        return tester(prov, undefined, false, (obj, v) => { obj.id = v; });
                    });
                });

                for (let i = 0; i <= 1; i++) {
                    it('Simple index put/get, getAll, getOnly, and getRange' + (i === 0 ? '' : ' (includeData)'), () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id',
                                    indexes: [
                                        {
                                            name: 'index',
                                            keyPath: 'a',
                                            includeDataInIndex: i === 1
                                        }
                                    ]
                                }
                            ]
                        }, true).then(prov => {
                            return tester(prov, 'index', false, (obj, v) => { obj.a = v; });
                        });
                    });
                }

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
                        return tester(prov, undefined, false, (obj, v) => { obj.a = { b: v }; });
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
                        return tester(prov, undefined, true, (obj, v1, v2) => { obj.a = v1; obj.b = v2; });
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

                for (let i = 0; i <= 1; i++) {
                    it('MultiEntry multipart indexed tests' + (i === 0 ? '' : ' (includeData)'), () => {
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
                                            keyPath: 'k.k',
                                            includeDataInIndex: i === 1
                                        }
                                    ]
                                }
                            ]
                        }, true).then(prov => {
                            return prov.put('test', { id: 'a', val: 'b', k: { k: ['w', 'x', 'y', 'z'] } })
                            // Insert data without multi-entry key defined
                            .then(() => prov.put('test', { id: 'c', val: 'd', k: [] }))
                            .then(() => prov.put('test', { id: 'e', val: 'f' }))
                            .then(() => {
                                var g1 = prov.get('test', 'a').then((ret: TestObj) => {
                                    assert.equal(ret.val, 'b');
                                });
                                var g2 = prov.getAll('test', 'key').then((ret: TestObj[]) => {
                                    assert.equal(ret.length, 4);
                                    ret.forEach(r => { assert.equal(r.val, 'b'); });
                                });
                                var g2b = prov.getAll('test', 'key', false, 2).then((ret: TestObj[]) => {
                                    assert.equal(ret.length, 2);
                                    ret.forEach(r => { assert.equal(r.val, 'b'); });
                                });
                                var g2c = prov.getAll('test', 'key', false, 2, 1).then((ret: TestObj[]) => {
                                    assert.equal(ret.length, 2);
                                    ret.forEach(r => { assert.equal(r.val, 'b'); });
                                });
                                var g3 = prov.getOnly('test', 'key', 'x').then((ret: TestObj[]) => {
                                    assert.equal(ret.length, 1);
                                    assert.equal(ret[0].val, 'b');
                                });
                                var g4 = prov.getRange('test', 'key', 'x', 'y', false, false).then((ret: TestObj[]) => {
                                    assert.equal(ret.length, 2);
                                    ret.forEach(r => { assert.equal(r.val, 'b'); });
                                });
                                return SyncTasks.all([g1, g2, g2b, g2c, g3, g4]).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    });
                }

                it('MultiEntry multipart indexed - update index', () => {
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
                        return prov.put('test', { id: 'a', val: 'b', k: { k: ['w', 'x', 'y', 'z'] } })
                        .then(() => {
                            return prov.getRange('test', 'key', 'x', 'y', false, false).then((ret: TestObj[]) => {
                                assert.equal(ret.length, 2);
                                ret.forEach(r => { assert.equal(r.val, 'b'); });
                            });
                        })
                        .then(() => {
                            return prov.put('test', { id: 'a', val: 'b', k: { k: ['z'] } });
                        })
                        .then(() => {
                            return prov.getRange('test', 'key', 'x', 'y', false, false).then(ret => {
                                assert.equal(ret.length, 0);
                            });
                        })
                        .then(() => {
                            return prov.getRange('test', 'key', 'x', 'z', false, false).then((ret: TestObj[]) => {
                                assert.equal(ret.length, 1);
                                assert.equal(ret[0].val, 'b');
                            });
                        })
                        .then(() => {
                            return prov.remove('test', 'a');
                        })
                        .then(() => {
                            return prov.getRange('test', 'key', 'x', 'z', false, false).then(ret => {
                                assert.equal(ret.length, 0);
                            });
                        })
                        .then(() => {
                            return prov.close();
                        });
                    });
                });

                it('MultiEntry multipart indexed tests - Compound Key', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: ['id', 'id2'],
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
                        return prov.put('test', { id: 'a', id2: '1', val: 'b', k: { k: ['w', 'x', 'y', 'z'] } })
                        // Insert data without multi-entry key defined
                        .then(() => prov.put('test', { id: 'c', id2: '2', val: 'd', k: [] }))
                        .then(() => prov.put('test', { id: 'e', id2: '3', val: 'f' }))
                        .then(() => {
                            var g1 = prov.get('test', ['a', '1']).then((ret: TestObj) => {
                                assert.equal(ret.val, 'b');
                            });
                            var g2 = prov.getAll('test', 'key').then((ret: TestObj[]) => {
                                assert.equal(ret.length, 4);
                                ret.forEach(r => { assert.equal(r.val, 'b'); });
                            });
                            var g2b = prov.getAll('test', 'key', false, 2).then((ret: TestObj[]) => {
                                assert.equal(ret.length, 2);
                                ret.forEach(r => { assert.equal(r.val, 'b'); });
                            });
                            var g2c = prov.getAll('test', 'key', false, 2, 1).then((ret: TestObj[]) => {
                                assert.equal(ret.length, 2);
                                ret.forEach(r => { assert.equal(r.val, 'b'); });
                            });
                            var g3 = prov.getOnly('test', 'key', 'x').then((ret: TestObj[]) => {
                                assert.equal(ret.length, 1);
                                assert.equal(ret[0].val, 'b');
                            });
                            var g4 = prov.getRange('test', 'key', 'x', 'y', false, false).then((ret: TestObj[]) => {
                                assert.equal(ret.length, 2);
                                ret.forEach(r => { assert.equal(r.val, 'b'); });
                            });
                            return SyncTasks.all([g1, g2, g2b, g2c, g3, g4]).then(() => {
                                return prov.close();
                            });
                        });
                    });
                });

                it('MultiEntry multipart indexed - update index - Compound', () => {
                    return openProvider(provName, {
                        version: 1,
                        stores: [
                            {
                                name: 'test',
                                primaryKeyPath: ['id', 'id2'],
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
                        return prov.put('test', { id: 'a', id2: '1', val: 'b', k: { k: ['w', 'x', 'y', 'z'] } })
                        .then(() => {
                            return prov.getRange('test', 'key', 'x', 'y', false, false).then((ret: TestObj[]) => {
                                assert.equal(ret.length, 2);
                                ret.forEach(r => { assert.equal(r.val, 'b'); });
                            });
                        })
                        .then(() => {
                            return prov.put('test', { id: 'a', id2: '1', val: 'b', k: { k: ['z'] } });
                        })
                        .then(() => {
                            return prov.getRange('test', 'key', 'x', 'y', false, false).then(ret => {
                                assert.equal(ret.length, 0);
                            });
                        })
                        .then(() => {
                            return prov.getRange('test', 'key', 'x', 'z', false, false).then((ret: TestObj[]) => {
                                assert.equal(ret.length, 1);
                                assert.equal(ret[0].val, 'b');
                            });
                        })
                        .then(() => {
                            return prov.remove('test', ['a', '1']);
                        })
                        .then(() => {
                            return prov.getRange('test', 'key', 'x', 'z', false, false).then(ret => {
                                assert.equal(ret.length, 0);
                            });
                        })
                        .then(() => {
                            return prov.close();
                        });
                    });
                });

                describe('Transaction Semantics', () => {
                    it('Testing transaction expiration', () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, true).then(prov => {
                            return prov.openTransaction(['test'], true).then(trans => {
                                let promise = trans.getCompletionPromise();
                                let check1 = false;
                                promise.then(() => {
                                    check1 = true;
                                }, err => {
                                    assert.ok(false, 'Bad');
                                });
                                return sleep(200).then(() => {
                                    assert.ok(check1);
                                    const store = trans.getStore('test');
                                    return store.put({ id: 'abc', a: 'a' });
                                });
                            }).then(() => {
                                assert.ok(false, 'Should fail');
                                return SyncTasks.Rejected<void>();
                            }, err => {
                                // woot
                                return undefined;
                            }).then(() => {
                                return prov.close();
                            });
                        });
                    });

                    it('Testing aborting', () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, true).then(prov => {
                            let checked = false;
                            return prov.openTransaction(['test'], true).then(trans => {
                                let promise = trans.getCompletionPromise();
                                const store = trans.getStore('test');
                                return store.put({ id: 'abc', a: 'a' }).then(() => {
                                    trans.abort();
                                    return promise.then(() => {
                                        assert.ok(false, 'Should fail');
                                    }, err => {
                                        return prov.get('test', 'abc').then(res => {
                                            assert.ok(!res);
                                            checked = true;
                                        });
                                    });
                                });
                            }).then(() => {
                                assert.ok(checked);
                                return prov.close();
                            });
                        });
                    });

                    it('Testing read/write transaction locks', () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', a: 'a' }).then(() => {
                                let check1 = false, check2 = false;
                                let started1 = false;
                                let closed1 = false;
                                const p1 = prov.openTransaction(['test'], true).then(trans => {
                                    trans.getCompletionPromise().then(() => {
                                        closed1 = true;
                                    });
                                    started1 = true;
                                    const store = trans.getStore('test');
                                    return store.put({ id: 'abc', a: 'b' }).then(() => {
                                        return store.get('abc').then((val: any) => {
                                            assert.ok(val && val.a === 'b');
                                            assert.ok(!closed1);
                                            check1 = true;
                                        });
                                    });
                                });
                                assert.ok(!closed1);
                                const p2 = prov.openTransaction(['test'], false).then(trans => {
                                    assert.ok(closed1);
                                    assert.ok(started1 && check1);
                                    const store = trans.getStore('test');
                                    return store.get('abc').then((val: any) => {
                                        assert.ok(val && val.a === 'b');
                                        check2 = true;
                                    });
                                });
                                return SyncTasks.all([p1, p2]).then(() => {
                                    assert.ok(check1 && check2);
                                });
                            }).then(() => {
                                return prov.close();
                            });
                        });
                    });
                });
            });

            if (provName.indexOf('memory') === -1) {
                describe('Schema Upgrades', () => {
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

                    it('Basic NOOP schema upgrade path', () => {
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

                    it('Adding new store', () => {
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
                                    },
                                    {
                                        name: 'test2',
                                        primaryKeyPath: 'ttt'
                                    }
                                ]
                            }, false).then(prov => {
                                return prov.put('test2', { id: 'def', ttt: 'ghi' }).then(() => {
                                    const p1 = prov.get('test', 'abc').then((item: TestObj) => {
                                        assert(!!item);
                                        assert.equal(item.id, 'abc');
                                    });
                                    const p2 = prov.get('test2', 'abc').then(item => {
                                        assert(!item);
                                    });
                                    const p3 = prov.get('test2', 'def').then(item => {
                                        assert(!item);
                                    });
                                    const p4 = prov.get('test2', 'ghi').then((item: TestObj) => {
                                        assert(!!item);
                                        assert.equal(item.id, 'def');
                                    });
                                    return SyncTasks.all([p1, p2, p3, p4]).then(() => {
                                        return prov.close();
                                    });
                                });
                            });
                        });
                    });

                    it('Removing old store', () => {
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

                    it('Remove store with index', () => {
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
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', tt: 'abc' }).then(() => {
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

                    it('Add index', () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', tt: 'a' }).then(() => {
                                return prov.close();
                            });
                        }).then(() => {
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
                            }, false).then(prov => {
                                const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                    assert.equal(items[0].tt, 'a');
                                });
                                const p2 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                    assert.equal(items[0].tt, 'a');
                                });
                                const p3 = prov.getOnly('test', 'ind1', 'abc').then(items => {
                                    assert.equal(items.length, 0);
                                });
                                return SyncTasks.all([p1, p2, p3]).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    });

                    if (provName.indexOf('indexeddb') !== 0) {
                        // This migration works on indexeddb because we don't check the types and the browsers silently accept it but just
                        // neglect to index the field...
                        it('Add index to boolean field should fail', () => {
                            return openProvider(provName, {
                                version: 1,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id'
                                    }
                                ]
                            }, true).then(prov => {
                                return prov.put('test', { id: 'abc', tt: true }).then(() => {
                                    return prov.close();
                                });
                            }).then(() => {
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
                                }, false).then(() => {
                                    return SyncTasks.Rejected('Should not work');
                                }, err => {
                                    return SyncTasks.Resolved();
                                });
                            });
                        });
                    }

                    it('Add multiEntry index', () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', tt: ['a', 'b'] }).then(() => {
                                return prov.close();
                            });
                        }).then(() => {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [{
                                            name: 'ind1',
                                            keyPath: 'tt',
                                            multiEntry: true
                                        }]
                                    }
                                ]
                            }, false).then(prov => {
                                const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p1b = prov.getOnly('test', 'ind1', 'b').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p2 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p3 = prov.getOnly('test', 'ind1', 'abc').then(items => {
                                    assert.equal(items.length, 0);
                                });
                                return SyncTasks.all([p1, p1b, p2, p3]).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    });

                    it('Changing multiEntry index', () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id',
                                    indexes: [{
                                        name: 'ind1',
                                        keyPath: 'tt',
                                        multiEntry: true
                                    }]
                                }
                            ]
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', tt: ['x', 'y'], ttb: ['a', 'b'] }).then(() => {
                                return prov.close();
                            });
                        }).then(() => {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [{
                                            name: 'ind1',
                                            keyPath: 'ttb',
                                            multiEntry: true
                                        }]
                                    }
                                ]
                            }, false).then(prov => {
                                const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p1b = prov.getOnly('test', 'ind1', 'b').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p1c = prov.getOnly('test', 'ind1', 'x').then(items => {
                                    assert.equal(items.length, 0);
                                });
                                const p2 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p3 = prov.getOnly('test', 'ind1', 'abc').then(items => {
                                    assert.equal(items.length, 0);
                                });
                                return SyncTasks.all([p1, p1b, p1c, p2, p3]).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    });

                    it('Removing old index', () => {
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
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', tt: 'a' }).then(() => {
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
                                return prov.getOnly('test', 'ind1', 'a').then(items => {
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

                    it('Changing index keypath', () => {
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
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', tt: 'a', ttb: 'b' }).then(() => {
                                return prov.close();
                            });
                        }).then(() => {
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
                            }, false).then(prov => {
                                const p1 = prov.getOnly('test', 'ind1', 'a').then(items => {
                                    assert.equal(items.length, 0);
                                });
                                const p2 = prov.getOnly('test', 'ind1', 'b').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].ttb, 'b');
                                });
                                const p3 = prov.getOnly('test', 'ind1', 'abc').then(items => {
                                    assert.equal(items.length, 0);
                                });
                                return SyncTasks.all([p1, p2, p3]).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    });

                    it('Change non-multientry index to includeDataInIndex', () => {
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
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', tt: 'a' }).then(() => {
                                return prov.close();
                            });
                        }).then(() => {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [{
                                            name: 'ind1',
                                            keyPath: 'tt',
                                            includeDataInIndex: true
                                        }]
                                    }
                                ]
                            }, false).then(prov => {
                                const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                    assert.equal(items[0].tt, 'a');
                                });
                                const p2 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                    assert.equal(items[0].tt, 'a');
                                });
                                const p3 = prov.getOnly('test', 'ind1', 'abc').then(items => {
                                    assert.equal(items.length, 0);
                                });
                                return SyncTasks.all([p1, p2, p3]).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    });

                    it('Change non-multientry index from includeDataInIndex', () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id',
                                    indexes: [{
                                        name: 'ind1',
                                        keyPath: 'tt',
                                        includeDataInIndex: true
                                    }]
                                }
                            ]
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', tt: 'a' }).then(() => {
                                return prov.close();
                            });
                        }).then(() => {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [{
                                            name: 'ind1',
                                            keyPath: 'tt',
                                            includeDataInIndex: false
                                        }]
                                    }
                                ]
                            }, false).then(prov => {
                                const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                    assert.equal(items[0].tt, 'a');
                                });
                                const p2 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                    assert.equal(items[0].tt, 'a');
                                });
                                const p3 = prov.getOnly('test', 'ind1', 'abc').then(items => {
                                    assert.equal(items.length, 0);
                                });
                                return SyncTasks.all([p1, p2, p3]).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    });

                    it('Change multientry index to includeDataInIndex', () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id',
                                    indexes: [{
                                        name: 'ind1',
                                        keyPath: 'tt',
                                        multiEntry: true
                                    }]
                                }
                            ]
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', tt: ['a', 'b'] }).then(() => {
                                return prov.close();
                            });
                        }).then(() => {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [{
                                            name: 'ind1',
                                            keyPath: 'tt',
                                            multiEntry: true,
                                            includeDataInIndex: true
                                        }]
                                    }
                                ]
                            }, false).then(prov => {
                                const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p1b = prov.getOnly('test', 'ind1', 'b').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p2 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p3 = prov.getOnly('test', 'ind1', 'abc').then(items => {
                                    assert.equal(items.length, 0);
                                });
                                return SyncTasks.all([p1, p1b, p2, p3]).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    });

                    it('Change multientry index from includeDataInIndex', () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id',
                                    indexes: [{
                                        name: 'ind1',
                                        keyPath: 'tt',
                                        multiEntry: true,
                                        includeDataInIndex: true
                                    }]
                                }
                            ]
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', tt: ['a', 'b'] }).then(() => {
                                return prov.close();
                            });
                        }).then(() => {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [{
                                            name: 'ind1',
                                            keyPath: 'tt',
                                            multiEntry: true,
                                            includeDataInIndex: false
                                        }]
                                    }
                                ]
                            }, false).then(prov => {
                                const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p1b = prov.getOnly('test', 'ind1', 'b').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p2 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                const p3 = prov.getOnly('test', 'ind1', 'abc').then(items => {
                                    assert.equal(items.length, 0);
                                });
                                return SyncTasks.all([p1, p1b, p2, p3]).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    });

                    it('Adding new FTS store', () => {
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
                                    },
                                    {
                                        name: 'test2',
                                        primaryKeyPath: 'id',
                                        indexes: [
                                            {
                                                name: 'a',
                                                keyPath: 'content',
                                                fullText: true
                                            }
                                        ]
                                    }
                                ]
                            }, false).then(prov => {
                                return prov.put('test2', { id: 'def', content: 'ghi' }).then(() => {
                                    const p1 = prov.get('test', 'abc').then((item: any) => {
                                        assert.ok(item);
                                        assert.equal(item.id, 'abc');
                                    });
                                    const p2 = prov.get('test2', 'abc').then(item => {
                                        assert.ok(!item);
                                    });
                                    const p3 = prov.get('test2', 'def').then(item => {
                                        assert.ok(item);
                                    });
                                    const p4 = prov.fullTextSearch('test2', 'a', 'ghi').then((items: any[]) => {
                                        assert.equal(items.length, 1);
                                        assert.equal(items[0].id, 'def');
                                    });
                                    return SyncTasks.all([p1, p2, p3, p4]).then(() => {
                                        return prov.close();
                                    });
                                });
                            });
                        });
                    });

                    it('Adding new FTS index', () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', content: 'ghi' }).then(() => {
                                return prov.close();
                            });
                        }).then(() => {
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [
                                            {
                                                name: 'a',
                                                keyPath: 'content',
                                                fullText: true
                                            }
                                        ]
                                    }
                                ]
                            }, false).then(prov => {
                                const p1 = prov.get('test', 'abc').then((item: any) => {
                                    assert.ok(item);
                                    assert.equal(item.id, 'abc');
                                });
                                const p2 = prov.fullTextSearch('test', 'a', 'ghi').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                });
                                return SyncTasks.all([p1, p2]).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    });

                    it('Removing FTS index', () => {
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id',
                                    indexes: [
                                        {
                                            name: 'a',
                                            keyPath: 'content',
                                            fullText: true
                                        }
                                    ]
                                }
                            ]
                        }, true).then(prov => {
                            return prov.put('test', { id: 'abc', content: 'ghi' }).then(() => {
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
                                const p1 = prov.get('test', 'abc').then((item: any) => {
                                    assert.ok(item);
                                    assert.equal(item.id, 'abc');
                                    assert.equal(item.content, 'ghi');
                                });
                                const p2 = prov.fullTextSearch('test', 'a', 'ghi').then((items: any[]) => {
                                    assert.equal(items.length, 1);
                                    assert.equal(items[0].id, 'abc');
                                }).then(() => {
                                    assert.ok(false, 'should not work');
                                }, err => {
                                    return SyncTasks.Resolved();
                                });
                                return SyncTasks.all([p1, p2]).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    });
                });
            }

            it('Full Text Index', () => {
                return openProvider(provName, {
                    version: 1,
                    stores: [
                        {
                            name: 'test',
                            primaryKeyPath: 'id',
                            indexes: [{
                                name: 'i',
                                keyPath: 'txt',
                                fullText: true
                            }]
                        }
                    ]
                }, true).then(prov => {
                    return prov.put('test', [
                            { id: 'a1', txt: 'the quick brown fox jumps over the lăzy dog who is a bro with brows' },
                            { id: 'a2', txt: 'bob likes his dog' },
                            { id: 'a3', txt: 'tes>ter'}]).then(() => {
                        const p1 = prov.fullTextSearch('test', 'i', 'brown').then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a1');
                        });
                        const p2 = prov.fullTextSearch('test', 'i', 'dog').then(res => {
                            assert.equal(res.length, 2);
                        });
                        const p3 = prov.fullTextSearch('test', 'i', 'do').then(res => {
                            assert.equal(res.length, 2);
                        });
                        const p4 = prov.fullTextSearch('test', 'i', 'LiKe').then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a2');
                        });
                        const p5 = prov.fullTextSearch('test', 'i', 'azy').then(res => {
                            assert.equal(res.length, 0);
                        });
                        const p6 = prov.fullTextSearch('test', 'i', 'lazy dog').then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a1');
                        });
                        const p7 = prov.fullTextSearch('test', 'i', 'dog lazy').then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a1');
                        });
                        const p8 = prov.fullTextSearch('test', 'i', 'DOG lăzy').then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a1');
                        });
                        const p9 = prov.fullTextSearch('test', 'i', 'lĄzy').then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a1');
                        });
                        const p10 = prov.fullTextSearch('test', 'i', 'brown brown brown').then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a1');
                        });
                        const p11 = prov.fullTextSearch('test', 'i', 'brown brOwn browN').then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a1');
                        });
                        const p12 = prov.fullTextSearch('test', 'i', 'brow').then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a1');
                        });
                        const p13 = prov.fullTextSearch('test', 'i', 'bro').then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a1');
                        });
                        const p14 = prov.fullTextSearch('test', 'i', 'br').then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a1');
                        });
                        const p15 = prov.fullTextSearch('test', 'i', 'b').then(res => {
                            assert.equal(res.length, 2);
                        });
                        const p16 = prov.fullTextSearch('test', 'i', 'b z').then(res => {
                            assert.equal(res.length, 0);
                        });
                        const p17 = prov.fullTextSearch('test', 'i', 'b z', NoSqlProvider.FullTextTermResolution.Or).then((res: any[]) => {
                            assert.equal(res.length, 2);
                            assert.ok(_.some(res, r => r.id === 'a1') && _.some(res, r => r.id === 'a2'));
                        });
                        const p18 = prov.fullTextSearch('test', 'i', 'q h', NoSqlProvider.FullTextTermResolution.Or).then((res: any[]) => {
                            assert.equal(res.length, 2);
                            assert.ok(_.some(res, r => r.id === 'a1') && _.some(res, r => r.id === 'a2'));
                        });
                        const p19 = prov.fullTextSearch('test', 'i', 'fox nopers', NoSqlProvider.FullTextTermResolution.Or)
                                .then((res: any[]) => {
                            assert.equal(res.length, 1);
                            assert.equal(res[0].id, 'a1');
                        });
                        const p20 = prov.fullTextSearch('test', 'i', 'foxers nopers', NoSqlProvider.FullTextTermResolution.Or)
                                .then(res => {
                            assert.equal(res.length, 0);
                        });
                        const p21 = prov.fullTextSearch('test', 'i', 'fox)', NoSqlProvider.FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 1);
                        });
                        const p22 = prov.fullTextSearch('test', 'i', 'fox*', NoSqlProvider.FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 1);
                        });
                        const p23 = prov.fullTextSearch('test', 'i', 'fox* fox( <fox>', NoSqlProvider.FullTextTermResolution.Or)
                                .then(res => {
                            assert.equal(res.length, 1);
                        });
                        const p24 = prov.fullTextSearch('test', 'i', 'f)ox', NoSqlProvider.FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 0);
                        });
                        const p25 = prov.fullTextSearch('test', 'i', 'fo*x', NoSqlProvider.FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 0);
                        });
                        const p26 = prov.fullTextSearch('test', 'i', 'tes>ter', NoSqlProvider.FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 1);
                        });
                        const p27 = prov.fullTextSearch('test', 'i', 'f*x', NoSqlProvider.FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 0);
                        });

                        return SyncTasks.all([p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15, p16, p17, p18, p19, p20,
                                p21, p22, p23, p24, p25, p26, p27]).then(() => {
                            return prov.close();
                        });
                    });
                });
            });
        });
    });
});
