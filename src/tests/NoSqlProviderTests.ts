import * as assert from 'assert';
import { find, each, times, values, keys, some, uniqueId } from 'lodash';
import * as sinon from 'sinon';
import * as SyncTasks from 'synctasks';

import { KeyComponentType, DbSchema, DbProvider, openListOfProviders, QuerySortOrder, FullTextTermResolution } from '../NoSqlProvider';

// import { CordovaNativeSqliteProvider } from '../CordovaNativeSqliteProvider';
import { InMemoryProvider } from '../InMemoryProvider';
import { IndexedDbProvider } from '../IndexedDbProvider';
import { WebSqlProvider } from '../WebSqlProvider';

import { serializeValueToOrderableString, isSafari } from '../NoSqlProviderUtils';
import { SqlTransaction } from '../SqlProviderBase';

// Don't trap exceptions so we immediately see them with a stack trace
SyncTasks.config.catchExceptions = false;

let cleanupFile = false;

type TestObj = { id?: string, val: string };

function openProvider(providerName: string, schema: DbSchema, wipeFirst: boolean) {
    let provider: DbProvider;
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
    return openListOfProviders([provider], dbName, schema, wipeFirst, false);
}

function sleep(timeMs: number): SyncTasks.Promise<void> {
    let defer = SyncTasks.Defer<void>();
    setTimeout(() => { defer.resolve(void 0); }, timeMs);
    return defer.promise();
}

describe('NoSqlProvider', function () {
    //this.timeout(60000);
    after(callback => {
        if (cleanupFile) {
            var fs = require('fs');
            fs.unlink('test', (err: any) => {
                if (err) {
                    throw err;
                }
                console.log('path/file.txt was deleted');
                callback();
            });
        }
    });

    let provsToTest: string[];
    if (typeof window === 'undefined') {
        // Non-browser environment...
        provsToTest = ['memory', 'sqlite3memory', 'sqlite3memorynofts3', 'sqlite3disk', 'sqlite3disknofts3'];
    } else {
        provsToTest = ['memory'];

        if (!isSafari()) {
            // Safari has broken indexeddb support, so let's not test it there.  Everywhere else should have it.
            // In IE, indexeddb will auto-run in fake keys mode, so if all is working, this is 2x the same test (but let's make sure!)
            provsToTest.push('indexeddb', 'indexeddbfakekeys');
        }

        if (window.openDatabase !== undefined) {
            // WebSQL theoretically supported!
            provsToTest.push('websql', 'websqlnofts3');
        }
    }

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
            assert(serializeValueToOrderableString(pair[0]) <
                serializeValueToOrderableString(pair[1]), 'failed for pair: ' + pair);
        });

        try {
            serializeValueToOrderableString([4, 5] as any as KeyComponentType);
            assert(false, 'Should reject this key');
        } catch (e) {
            // Should throw -- expecting this result.
        }
    });

    provsToTest.forEach(provName => {
        describe('Provider: ' + provName, () => {

            describe('Delete database', () => {
                if (provName.indexOf('memory') !== -1) {
                    xit('Skip delete test for in memory DB', () => {
                        //noop
                    });
                } else if (provName.indexOf('indexeddb') === 0) {
                    it('Deletes the database', () => {
                        const schema = {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        };
                        return openProvider(provName, schema, true)
                            .then(prov => {
                                // insert some stuff
                                return prov.put('test', { id: 'a', val: 'b' })
                                    //then delete
                                    .then(() => prov.deleteDatabase());
                            })
                            .then(() => openProvider(provName, schema, false))
                            .then(prov => {
                                return prov.get('test', 'a').then(retVal => {
                                    const ret = retVal as TestObj;
                                    // not found
                                    assert(!ret);
                                    return prov.close();
                                });
                            });

                    });
                } else {
                    it('Rejects with an error', () => {
                        const schema = {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id'
                                }
                            ]
                        };
                        return openProvider(provName, schema, true).
                            then(prov => {
                                // insert some stuff
                                return prov.put('test', { id: 'a', val: 'b' })
                                    .then(() => prov.deleteDatabase());
                            })
                            .then(() => {
                                //this should not happen
                                assert(false, 'Should fail');
                            }).catch(() => {
                                // as expected, didn't delete anything
                                return openProvider(provName, schema, false)
                                    .then(prov => prov.get('test', 'a').then(retVal => {
                                        const ret = retVal as TestObj;
                                        assert.equal(ret.val, 'b');
                                        return prov.close();
                                    }));
                            });
                    });
                }
            });

            describe('Data Manipulation', () => {
                // Setter should set the testable parameter on the first param to the value in the second param, and third param to the
                // second index column for compound indexes.
                var tester = (prov: DbProvider, indexName: string | undefined, compound: boolean,
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

                        let t1 = prov.getAll('test', indexName).then(retVal => {
                            const ret = retVal as TestObj[];
                            assert.equal(ret.length, 5, 'getAll');
                            [1, 2, 3, 4, 5].forEach(v => { assert(find(ret, r => r.val === 'val' + v), 'cant find ' + v); });
                        });

                        let t1count = prov.countAll('test', indexName).then(ret => {
                            assert.equal(ret, 5, 'countAll');
                        });

                        let t1b = prov.getAll('test', indexName, false, 3).then(retVal => {
                            const ret = retVal as TestObj[];
                            assert.equal(ret.length, 3, 'getAll lim3');
                            [1, 2, 3].forEach(v => { assert(find(ret, r => r.val === 'val' + v), 'cant find ' + v); });
                        });

                        let t1c = prov.getAll('test', indexName, false, 3, 1).then(retVal => {
                            const ret = retVal as TestObj[];
                            assert.equal(ret.length, 3, 'getAll lim3 off1');
                            [2, 3, 4].forEach(v => { assert(find(ret, r => r.val === 'val' + v), 'cant find ' + v); });
                        });

                        let t2 = prov.getOnly('test', indexName, formIndex(3)).then(ret => {
                            assert.equal(ret.length, 1, 'getOnly');
                            assert.equal((ret[0] as TestObj).val, 'val3');
                        });

                        let t2count = prov.countOnly('test', indexName, formIndex(3)).then(ret => {
                            assert.equal(ret, 1, 'countOnly');
                        });

                        let t3 = prov.getRange('test', indexName, formIndex(2), formIndex(4)).then(retVal => {
                            const ret = retVal as TestObj[];
                            assert.equal(ret.length, 3, 'getRange++');
                            [2, 3, 4].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                        });

                        let t3count = prov.countRange('test', indexName, formIndex(2), formIndex(4)).then(ret => {
                            assert.equal(ret, 3, 'countRange++');
                        });

                        let t3b = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 1)
                            .then(retVal => {
                                const ret = retVal as TestObj[];
                                assert.equal(ret.length, 1, 'getRange++ lim1');
                                [2].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3b2 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 1)
                            .then(retVal => {
                                const ret = retVal as TestObj[];
                                assert.equal(ret.length, 1, 'getRange++ lim1');
                                [2].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3b3 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false,
                            QuerySortOrder.Forward, 1)
                            .then(retVal => {
                                const ret = retVal as TestObj[];
                                assert.equal(ret.length, 1, 'getRange++ lim1');
                                [2].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3b4 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false,
                            QuerySortOrder.Reverse, 1)
                            .then(retVal => {
                                const ret = retVal as TestObj[];
                                assert.equal(ret.length, 1, 'getRange++ lim1 rev');
                                [4].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3c = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 1, 1)
                            .then(retVal => {
                                const ret = retVal as TestObj[];
                                assert.equal(ret.length, 1, 'getRange++ lim1 off1');
                                [3].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3d = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, false, 2, 1)
                            .then(retVal => {
                                const ret = retVal as TestObj[];
                                assert.equal(ret.length, 2, 'getRange++ lim2 off1');
                                [3, 4].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3d2 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false,
                            QuerySortOrder.Forward, 2, 1)
                            .then(retVal => {
                                const ret = retVal as TestObj[];
                                assert.equal(ret.length, 2, 'getRange++ lim2 off1');
                                [3, 4].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3d3 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false, true, 2, 1)
                            .then(retVal => {
                                const ret = retVal as TestObj[];
                                assert.equal(ret.length, 2, 'getRange++ lim2 off1 rev');
                                assert.equal((ret[0] as TestObj).val, 'val3');
                                [2, 3].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                            });

                        let t3d4 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, false,
                            QuerySortOrder.Reverse, 2, 1)
                            .then(retVal => {
                                const ret = retVal as TestObj[];
                                assert.equal(ret.length, 2, 'getRange++ lim2 off1 rev');
                                assert.equal((ret[0] as TestObj).val, 'val3');
                                [2, 3].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                            });

                        let t4 = prov.getRange('test', indexName, formIndex(2), formIndex(4), true, false).then(retVal => {
                            const ret = retVal as TestObj[];
                            assert.equal(ret.length, 2, 'getRange-+');
                            [3, 4].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                        });

                        let t4count = prov.countRange('test', indexName, formIndex(2), formIndex(4), true, false).then(ret => {
                            assert.equal(ret, 2, 'countRange-+');
                        });

                        let t5 = prov.getRange('test', indexName, formIndex(2), formIndex(4), false, true).then(retVal => {
                            const ret = retVal as TestObj[];
                            assert.equal(ret.length, 2, 'getRange+-');
                            [2, 3].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                        });

                        let t5count = prov.countRange('test', indexName, formIndex(2), formIndex(4), false, true).then(ret => {
                            assert.equal(ret, 2, 'countRange+-');
                        });

                        let t6 = prov.getRange('test', indexName, formIndex(2), formIndex(4), true, true).then(retVal => {
                            const ret = retVal as TestObj[];
                            assert.equal(ret.length, 1, 'getRange--');
                            [3].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                        });

                        let t6count = prov.countRange('test', indexName, formIndex(2), formIndex(4), true, true).then(ret => {
                            assert.equal(ret, 1, 'countRange--');
                        });

                        return SyncTasks.all([t1, t1count, t1b, t1c, t2, t2count, t3, t3count, t3b, t3b2, t3b3, t3b4, t3c, t3d, t3d2, t3d3,
                            t3d4, t4, t4count, t5, t5count, t6, t6count]).then(() => {
                                if (compound) {
                                    let tt1 = prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3))
                                        .then(retVal => {
                                            const ret = retVal as TestObj[];
                                            assert.equal(ret.length, 2, 'getRange2++');
                                            [2, 3].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                                        });

                                    let tt1count = prov.countRange('test', indexName, formIndex(2, 2), formIndex(4, 3))
                                        .then(ret => {
                                            assert.equal(ret, 2, 'countRange2++');
                                        });

                                    let tt2 = prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3), false, true)
                                        .then(retVal => {
                                            const ret = retVal as TestObj[];
                                            assert.equal(ret.length, 2, 'getRange2+-');
                                            [2, 3].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
                                        });

                                    let tt2count = prov.countRange('test', indexName, formIndex(2, 2), formIndex(4, 3), false, true)
                                        .then(ret => {
                                            assert.equal(ret, 2, 'countRange2+-');
                                        });

                                    let tt3 = prov.getRange('test', indexName, formIndex(2, 2), formIndex(4, 3), true, false)
                                        .then(retVal => {
                                            const ret = retVal as TestObj[];
                                            assert.equal(ret.length, 1, 'getRange2-+');
                                            [3].forEach(v => { assert(find(ret, r => r.val === 'val' + v)); });
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
                            return prov.get('test', 'a').then(retVal => {
                                const ret = retVal as TestObj;
                                assert.equal(ret.val, 'b');

                                return prov.getAll('test', undefined).then(ret2Val => {
                                    const ret2 = ret2Val as TestObj[];
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
                                            return prov.getAll('test', undefined).then(retVals => {
                                                const rets = retVals as TestObj[];
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
                                    var g1 = prov.get('test', 'a').then(retVal => {
                                        const ret = retVal as TestObj;
                                        assert.equal(ret.val, 'b');
                                    });
                                    var g2 = prov.getAll('test', 'key').then(retVal => {
                                        const ret = retVal as TestObj[];
                                        assert.equal(ret.length, 4);
                                        ret.forEach(r => { assert.equal(r.val, 'b'); });
                                    });
                                    var g2b = prov.getAll('test', 'key', false, 2).then(retVal => {
                                        const ret = retVal as TestObj[];
                                        assert.equal(ret.length, 2);
                                        ret.forEach(r => { assert.equal(r.val, 'b'); });
                                    });
                                    var g2c = prov.getAll('test', 'key', false, 2, 1).then(retVal => {
                                        const ret = retVal as TestObj[];
                                        assert.equal(ret.length, 2);
                                        ret.forEach(r => { assert.equal(r.val, 'b'); });
                                    });
                                    var g3 = prov.getOnly('test', 'key', 'x').then(retVal => {
                                        const ret = retVal as TestObj[];
                                        assert.equal(ret.length, 1);
                                        assert.equal(ret[0].val, 'b');
                                    });
                                    var g4 = prov.getRange('test', 'key', 'x', 'y', false, false).then(retVal => {
                                        const ret = retVal as TestObj[];
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
                                return prov.getRange('test', 'key', 'x', 'y', false, false).then(retVal => {
                                    const ret = retVal as TestObj[];
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
                                return prov.getRange('test', 'key', 'x', 'z', false, false).then(retVal => {
                                    const ret = retVal as TestObj[];
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

                // Ensure that we properly batch multi-key sql inserts
                if (provName.indexOf('sql') !== -1) {
                    it('MultiEntry multipart index - large index put', () => {
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
                                        }
                                    ]
                                }
                            ]
                        }, true).then(prov => {
                            const keys: string[] = [];
                            times(1000, () => {
                                keys.push(uniqueId('multipartKey'));
                            });
                            return prov.put('test', { id: 'a', val: 'b', k: { k: keys } });
                        });
                    });
                }

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
                                var g1 = prov.get('test', ['a', '1']).then(retVal => {
                                    const ret = retVal as TestObj;
                                    assert.equal(ret.val, 'b');
                                });
                                var g2 = prov.getAll('test', 'key').then(retVal => {
                                    const ret = retVal as TestObj[];
                                    assert.equal(ret.length, 4);
                                    ret.forEach(r => { assert.equal(r.val, 'b'); });
                                });
                                var g2b = prov.getAll('test', 'key', false, 2).then(retVal => {
                                    const ret = retVal as TestObj[];
                                    assert.equal(ret.length, 2);
                                    ret.forEach(r => { assert.equal(r.val, 'b'); });
                                });
                                var g2c = prov.getAll('test', 'key', false, 2, 1).then(retVal => {
                                    const ret = retVal as TestObj[];
                                    assert.equal(ret.length, 2);
                                    ret.forEach(r => { assert.equal(r.val, 'b'); });
                                });
                                var g3 = prov.getOnly('test', 'key', 'x').then(retVal => {
                                    const ret = retVal as TestObj[];
                                    assert.equal(ret.length, 1);
                                    assert.equal(ret[0].val, 'b');
                                });
                                var g4 = prov.getRange('test', 'key', 'x', 'y', false, false).then(retVal => {
                                    const ret = retVal as TestObj[];
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
                                return prov.getRange('test', 'key', 'x', 'y', false, false).then(retVal => {
                                    const ret = retVal as TestObj[];
                                    assert.equal(ret.length, 2);
                                    ret.forEach(r => { assert.equal(r.val, 'b'); });
                                });
                            })
                            .then(() => {
                                return prov.put('test', { id: 'a', id2: '1', val: 'b', k: { k: ['z'] } });
                            })
                            .then(() => {
                                return prov.getRange('test', 'key', 'x', 'y', false, false).then(retVal => {
                                    const ret = retVal as TestObj[];
                                    assert.equal(ret.length, 0);
                                });
                            })
                            .then(() => {
                                return prov.getRange('test', 'key', 'x', 'z', false, false).then(retVal => {
                                    const ret = retVal as TestObj[];
                                    assert.equal(ret.length, 1);
                                    assert.equal(ret[0].val, 'b');
                                });
                            })
                            .then(() => {
                                return prov.remove('test', ['a', '1']);
                            })
                            .then(() => {
                                return prov.getRange('test', 'key', 'x', 'z', false, false).then(retVal => {
                                    const ret = retVal as TestObj[];
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
                                    const p1 = prov.get('test', 'abc').then(itemVal => {
                                        const item = itemVal as TestObj;
                                        assert(!!item);
                                        assert.equal(item.id, 'abc');
                                    });
                                    const p2 = prov.get('test2', 'abc').then(item => {
                                        assert(!item);
                                    });
                                    const p3 = prov.get('test2', 'def').then(item => {
                                        assert(!item);
                                    });
                                    const p4 = prov.get('test2', 'ghi').then(itemVal => {
                                        const item = itemVal as TestObj;
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

                    function testBatchUpgrade(expectedCallCount: number, itemByteSize: number): SyncTasks.Promise<void> {
                        const recordCount = 5000;
                        const data: { [id: string]: { id: string, tt: string } } = {};
                        times(recordCount, num => {
                            data[num.toString()] = {
                                id: num.toString(),
                                tt: 'tt' + num.toString()
                            };
                        });
                        return openProvider(provName, {
                            version: 1,
                            stores: [
                                {
                                    name: 'test',
                                    primaryKeyPath: 'id',
                                    estimatedObjBytes: itemByteSize
                                }
                            ]
                        }, true).then(prov => {
                            return prov.put('test', values(data)).then(() => {
                                return prov.close();
                            });
                        }).then(() => {
                            let transactionSpy: sinon.SinonSpy | undefined;
                            if (provName.indexOf('sql') !== -1) {
                                // Check that we batch the upgrade by spying on number of queries indirectly
                                // This only affects sql-based tests
                                transactionSpy = sinon.spy(SqlTransaction.prototype, 'internal_getResultsFromQuery') as any;
                            }
                            return openProvider(provName, {
                                version: 2,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        estimatedObjBytes: itemByteSize,
                                        indexes: [{
                                            name: 'ind1',
                                            keyPath: 'tt'
                                        }]
                                    }
                                ]
                            }, false).then(prov => {
                                if (transactionSpy) {
                                    assert.equal(transactionSpy.callCount, expectedCallCount, 'Incorrect transaction count');
                                    transactionSpy.restore();
                                }
                                return prov.getAll('test', undefined).then((records: any) => {
                                    assert.equal(records.length, keys(data).length, 'Incorrect record count');
                                    each(records, dbRecordToValidate => {
                                        const originalRecord = data[dbRecordToValidate.id];
                                        assert.ok(!!originalRecord);
                                        assert.equal(originalRecord.id, dbRecordToValidate.id);
                                        assert.equal(originalRecord.tt, dbRecordToValidate.tt);
                                    });
                                }).then(() => {
                                    return prov.close();
                                });
                            });
                        });
                    }

                    it('Add index - Large records - batched upgrade', () => {
                        return testBatchUpgrade(51, 10000);
                    });

                    it('Add index - small records - No batch upgrade', () => {
                        return testBatchUpgrade(1, 1);
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

                    // indexed db might backfill anyway behind the scenes
                    if (provName.indexOf('indexeddb') !== 0) {

                        it('Adding an index that does not require backfill', () => {
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
                                                keyPath: 'tt',
                                                doNotBackfill: true
                                            }]
                                        }
                                    ]
                                }, false).then(prov => prov.put('test', { id: 'bcd', tt: 'b' }).then(() => {
                                    const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                        // item not found, we didn't backfill the first item
                                        assert.equal(items.length, 0);
                                    });
                                    const p2 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                        assert.equal(items.length, 1);
                                        assert.equal(items[0].id, 'abc');
                                        assert.equal(items[0].tt, 'a');
                                    });
                                    const p3 = prov.getOnly('test', 'ind1', 'b').then((items: any[]) => {
                                        // index works properly for the new item
                                        assert.equal(items.length, 1);
                                        assert.equal(items[0].id, 'bcd');
                                        assert.equal(items[0].tt, 'b');
                                    });
                                    return SyncTasks.all([p1, p2, p3]).then(() => {
                                        return prov.close();
                                    });
                                }));
                            });
                        });

                        it('Adding two indexes at once - backfill and not', () => {
                            return openProvider(provName, {
                                version: 1,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id'
                                    }
                                ]
                            }, true).then(prov => {
                                return prov.put('test', { id: 'abc', tt: 'a', zz: 'b' }).then(() => {
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
                                                    name: 'ind1',
                                                    keyPath: 'tt',
                                                    doNotBackfill: true,
                                                },
                                                {
                                                    name: 'ind2',
                                                    keyPath: 'zz',
                                                }
                                            ]
                                        }
                                    ]
                                }, false).then(prov => {
                                    const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                        // we had to backfill, so we filled all 
                                        assert.equal(items.length, 1);
                                        assert.equal(items[0].id, 'abc');
                                        assert.equal(items[0].tt, 'a');
                                        assert.equal(items[0].zz, 'b');
                                    });
                                    const p2 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                        assert.equal(items.length, 1);
                                        assert.equal(items[0].id, 'abc');
                                        assert.equal(items[0].tt, 'a');
                                        assert.equal(items[0].zz, 'b');
                                    });
                                    const p3 = prov.getOnly('test', 'ind2', 'b').then((items: any[]) => {
                                        // index works properly for the second index
                                        assert.equal(items.length, 1);
                                        assert.equal(items[0].id, 'abc');
                                        assert.equal(items[0].tt, 'a');
                                        assert.equal(items[0].zz, 'b');
                                    });
                                    return SyncTasks.all([p1, p2, p3]).then(() => {
                                        return prov.close();
                                    });
                                });
                            });
                        });

                        it('Change no backfill index into a normal index', () => {
                            return openProvider(provName, {
                                version: 1,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [
                                            {
                                                name: 'ind1',
                                                keyPath: 'tt',
                                                doNotBackfill: true,
                                            },
                                        ]
                                    }
                                ]
                            }, true).then(prov => {
                                return prov.put('test', { id: 'abc', tt: 'a', zz: 'b' }).then(() => {
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
                                                    name: 'ind1',
                                                    keyPath: 'tt',
                                                },
                                            ]
                                        }
                                    ]
                                }, false).then(prov => {
                                    const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                        // we backfilled 
                                        assert.equal(items.length, 1);
                                        assert.equal(items[0].id, 'abc');
                                        assert.equal(items[0].tt, 'a');
                                        assert.equal(items[0].zz, 'b');
                                    });
                                    const p2 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                        assert.equal(items.length, 1);
                                        assert.equal(items[0].id, 'abc');
                                        assert.equal(items[0].tt, 'a');
                                        assert.equal(items[0].zz, 'b');
                                    });
                                    return SyncTasks.all([p1, p2]).then(() => {
                                        return prov.close();
                                    });
                                });
                            });
                        });

                        it('Perform two updates which require no backfill', () => {
                            return openProvider(provName, {
                                version: 1,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id'
                                    }
                                ]
                            }, true)
                                .then(prov => {
                                    return prov.put('test', { id: 'abc', tt: 'a', zz: 'aa' }).then(() => {
                                        return prov.close();
                                    });
                                })
                                .then(() => {
                                    return openProvider(provName, {
                                        version: 2,
                                        stores: [
                                            {
                                                name: 'test',
                                                primaryKeyPath: 'id',
                                                indexes: [{
                                                    name: 'ind1',
                                                    keyPath: 'tt',
                                                    doNotBackfill: true
                                                }]
                                            }
                                        ]
                                    }, false)
                                        .then(prov => {
                                            return prov.put('test', { id: 'bcd', tt: 'b', zz: 'bb' }).then(() => {
                                                return prov.close();
                                            });
                                        });
                                })
                                .then(() => {
                                    return openProvider(provName, {
                                        version: 3,
                                        stores: [
                                            {
                                                name: 'test',
                                                primaryKeyPath: 'id',
                                                indexes: [{
                                                    name: 'ind1',
                                                    keyPath: 'tt',
                                                    doNotBackfill: true
                                                }, {
                                                    name: 'ind2',
                                                    keyPath: 'zz',
                                                    doNotBackfill: true
                                                }]
                                            }
                                        ]
                                    }, false)
                                        .then(prov => {
                                            const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                                // item not found, we didn't backfill the first item
                                                assert.equal(items.length, 0);
                                            });
                                            const p2 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                                assert.equal(items.length, 1);
                                                assert.equal(items[0].id, 'abc');
                                                assert.equal(items[0].tt, 'a');
                                                assert.equal(items[0].zz, 'aa');
                                            });
                                            const p3 = prov.getOnly('test', 'ind1', 'b').then((items: any[]) => {
                                                // first index works properly for the second item
                                                assert.equal(items.length, 1);
                                                assert.equal(items[0].id, 'bcd');
                                                assert.equal(items[0].tt, 'b');
                                            });
                                            const p4 = prov.getOnly('test', 'ind2', 'bb').then((items: any[]) => {
                                                // second index wasn't backfilled
                                                assert.equal(items.length, 0);
                                            });
                                            return SyncTasks.all([p1, p2, p3, p4]).then(() => {
                                                return prov.close();
                                            });
                                        });
                                });
                        });

                        it('Removes index without pulling data to JS', () => {
                            let storeSpy: sinon.SinonSpy | undefined;
                            return openProvider(provName, {
                                version: 1,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [
                                            {
                                                name: 'ind1',
                                                keyPath: 'content',
                                            }
                                        ]
                                    }
                                ]
                            }, true).then(prov => {
                                return prov.put('test', { id: 'abc', content: 'ghi' }).then(() => {
                                    return prov.close();
                                });
                            }).then(() => {
                                storeSpy = sinon.spy(SqlTransaction.prototype, 'getStore') as any;
                                return openProvider(provName, {
                                    version: 2,
                                    stores: [
                                        {
                                            name: 'test',
                                            primaryKeyPath: 'id'
                                        }
                                    ]
                                }, false)
                                    .then(prov => {
                                        // NOTE - the line below tests an implementation detail
                                        sinon.assert.notCalled(storeSpy!!!);

                                        // check the index was actually removed
                                        const p1 = prov.get('test', 'abc').then((item: any) => {
                                            assert.ok(item);
                                            assert.equal(item.id, 'abc');
                                            assert.equal(item.content, 'ghi');
                                        });
                                        const p2 = prov.getOnly('test', 'ind1', 'ghi').then((items: any[]) => {
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
                            }).finally(() => {
                                if (storeSpy) {
                                    storeSpy.restore();
                                }
                            });
                        });

                        it('Cleans up stale indices from metadata', () => {
                            return openProvider(provName, {
                                version: 1,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [
                                            {
                                                name: 'ind1',
                                                keyPath: 'content',
                                            },
                                            {
                                                name: 'ind2',
                                                keyPath: 'content',
                                            }
                                        ]
                                    }
                                ]
                            }, true)
                                .then(prov => prov.close())
                                .then(() => {
                                    return openProvider(provName, {
                                        version: 2,
                                        stores: [
                                            {
                                                name: 'test',
                                                primaryKeyPath: 'id'
                                            }
                                        ]
                                    }, false)
                                        .then(prov => {
                                            return prov.openTransaction(undefined, false).then(trans => {
                                                return (trans as SqlTransaction).runQuery('SELECT name, value from metadata').then(fullMeta => {
                                                    each(fullMeta, (meta: any) => {
                                                        let metaObj = JSON.parse(meta.value);
                                                        if (metaObj.storeName === 'test' && !!metaObj.index && metaObj.index.name === 'ind1') {
                                                            assert.fail('Removed index should not exist in the meta!');
                                                        }
                                                    });
                                                });
                                            }).then(() => {
                                                return prov.close();
                                            });
                                        });
                                });
                        });

                        it('Add and remove index in the same upgrade', () => {
                            return openProvider(provName, {
                                version: 1,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [{
                                            name: 'ind1',
                                            keyPath: 'tt',
                                            doNotBackfill: true
                                        }]
                                    }
                                ]
                            }, true)
                                .then(prov => {
                                    return prov.put('test', { id: 'abc', tt: 'a', zz: 'aa' }).then(() => {
                                        return prov.close();
                                    });
                                })
                                .then(() => {
                                    return openProvider(provName, {
                                        version: 2,
                                        stores: [
                                            {
                                                name: 'test',
                                                primaryKeyPath: 'id',
                                                indexes: [{
                                                    name: 'ind2',
                                                    keyPath: 'zz',
                                                    doNotBackfill: true
                                                }]
                                            }
                                        ]
                                    }, false)
                                        .then(prov => {
                                            const p1 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                                assert.equal(items.length, 1);
                                                assert.equal(items[0].id, 'abc');
                                                assert.equal(items[0].tt, 'a');
                                                assert.equal(items[0].zz, 'aa');
                                            });
                                            const p2 = prov.getOnly('test', 'ind1', 'a').then(items => {
                                                return SyncTasks.Rejected<void>('Shouldn\'t have worked');
                                            }, () => {
                                                // Expected to fail, so chain from failure to success
                                                return undefined;
                                            });

                                            return SyncTasks.all([p1, p2]).then(() => {
                                                return prov.close();
                                            });
                                        });
                                });
                        });

                        it('Recreates missing indices', () => {
                            return openProvider(provName, {
                                version: 1,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [{
                                            name: 'ind1',
                                            keyPath: 'tt',
                                            doNotBackfill: true
                                        }]
                                    }
                                ]
                            }, true)
                                .then(prov => {
                                    return prov.put('test', { id: 'abc', tt: 'a', zz: 'aa' })
                                        .then(() => {
                                            return prov.openTransaction(['test'], true).then(trans => {
                                                // simulate broken index
                                                return (trans as SqlTransaction).runQuery('DROP INDEX test_ind1');
                                            });
                                        })
                                        .then(() => {
                                            return prov.close();
                                        });
                                })
                                .then(() => {
                                    return openProvider(provName, {
                                        version: 2,
                                        stores: [
                                            {
                                                name: 'test',
                                                primaryKeyPath: 'id',
                                                indexes: [{
                                                    name: 'ind1',
                                                    keyPath: 'tt',
                                                    doNotBackfill: true
                                                }]
                                            }
                                        ]
                                    }, false)
                                        .then(prov => {
                                            const p1 = prov.getOnly('test', 'ind1', 'a').then((items: any[]) => {
                                                assert.equal(items.length, 1);
                                                assert.equal(items[0].id, 'abc');
                                                assert.equal(items[0].tt, 'a');
                                                assert.equal(items[0].zz, 'aa');
                                            });

                                            const p2 = prov.openTransaction(undefined, false).then(trans => {
                                                return (trans as SqlTransaction).runQuery('SELECT type, name, tbl_name, sql from sqlite_master')
                                                    .then(fullMeta => {
                                                        const oldIndexReallyExists = some(fullMeta, (metaObj: any) => {
                                                            if (metaObj.type === 'index' && metaObj.tbl_name === 'test'
                                                                && metaObj.name === 'test_ind1') {
                                                                return true;
                                                            }
                                                            return false;
                                                        });
                                                        if (!oldIndexReallyExists) {
                                                            return SyncTasks.Rejected('Unchanged index should still exist!');
                                                        }
                                                        return SyncTasks.Resolved(undefined);
                                                    });
                                            });

                                            return SyncTasks.all([p1, p2]).then(() => {
                                                return prov.close();
                                            });
                                        });
                                });
                        });

                        it('Add remove index in the same upgrade, while preserving other indices', () => {
                            return openProvider(provName, {
                                version: 1,
                                stores: [
                                    {
                                        name: 'test',
                                        primaryKeyPath: 'id',
                                        indexes: [{
                                            name: 'ind1',
                                            keyPath: 'tt',
                                            doNotBackfill: true
                                        }, {
                                            name: 'ind2',
                                            keyPath: 'zz',
                                            doNotBackfill: true
                                        }]
                                    }
                                ]
                            }, true)
                                .then(prov => {
                                    return prov.put('test', { id: 'abc', tt: 'a', zz: 'aa' }).then(() => {
                                        return prov.close();
                                    });
                                })
                                .then(() => {
                                    return openProvider(provName, {
                                        version: 2,
                                        stores: [
                                            {
                                                name: 'test',
                                                primaryKeyPath: 'id',
                                                indexes: [{
                                                    name: 'ind2',
                                                    keyPath: 'zz',
                                                    doNotBackfill: true
                                                }, {
                                                    name: 'ind3',
                                                    keyPath: 'zz',
                                                    doNotBackfill: true
                                                }]
                                            }
                                        ]
                                    }, false)
                                        .then(prov => {
                                            const p1 = prov.getOnly('test', undefined, 'abc').then((items: any[]) => {
                                                assert.equal(items.length, 1);
                                                assert.equal(items[0].id, 'abc');
                                                assert.equal(items[0].tt, 'a');
                                                assert.equal(items[0].zz, 'aa');
                                            });
                                            const p2 = prov.getOnly('test', 'ind2', 'aa').then((items: any[]) => {
                                                assert.equal(items.length, 1);
                                                assert.equal(items[0].id, 'abc');
                                                assert.equal(items[0].tt, 'a');
                                                assert.equal(items[0].zz, 'aa');
                                            });
                                            const p3 = prov.getOnly('test', 'ind1', 'a').then(items => {
                                                return SyncTasks.Rejected<void>('Shouldn\'t have worked');
                                            }, () => {
                                                // Expected to fail, so chain from failure to success
                                                return undefined;
                                            });

                                            const p4 = prov.openTransaction(undefined, false).then(trans => {
                                                return (trans as SqlTransaction).runQuery('SELECT type, name, tbl_name, sql from sqlite_master')
                                                    .then(fullMeta => {
                                                        const oldIndexReallyExists = some(fullMeta, (metaObj: any) => {
                                                            if (metaObj.type === 'index' && metaObj.tbl_name === 'test'
                                                                && metaObj.name === 'test_ind2') {
                                                                return true;
                                                            }
                                                            return false;
                                                        });
                                                        if (!oldIndexReallyExists) {
                                                            return SyncTasks.Rejected('Unchanged index should still exist!');
                                                        }
                                                        return SyncTasks.Resolved(undefined);
                                                    });
                                            });

                                            return SyncTasks.all([p1, p2, p3, p4]).then(() => {
                                                return prov.close();
                                            });
                                        });
                                });
                        });
                    }
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
                        { id: 'a3', txt: 'tes>ter' },
                        {
                            id: 'a4',
                            txt: 'Бывает проснешься как птица,' +
                                ' крылатой пружиной на взводе и хочется жить и трудиться, но к завтраку это проходит!'
                        },
                        {
                            id: 'a5',
                            txt: '漁夫從遠處看見漁夫'
                        },
                        {
                            // i18n digits test case
                            id: 'a6',
                            txt: '߂i18nDigits߂'
                        },
                        {
                            // Test data to make sure that we don't search for empty strings (... used to put empty string to the index)
                            id: 'a7',
                            txt: 'User1, User2, User3 ...'
                        }
                    ]).then(() => {
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
                        const p17 = prov.fullTextSearch('test', 'i', 'b z', FullTextTermResolution.Or).then((res: any[]) => {
                            assert.equal(res.length, 2);
                            assert.ok(some(res, r => r.id === 'a1') && some(res, r => r.id === 'a2'));
                        });
                        const p18 = prov.fullTextSearch('test', 'i', 'q h', FullTextTermResolution.Or).then((res: any[]) => {
                            assert.equal(res.length, 2);
                            assert.ok(some(res, r => r.id === 'a1') && some(res, r => r.id === 'a2'));
                        });
                        const p19 = prov.fullTextSearch('test', 'i', 'fox nopers', FullTextTermResolution.Or)
                            .then((res: any[]) => {
                                assert.equal(res.length, 1);
                                assert.equal(res[0].id, 'a1');
                            });
                        const p20 = prov.fullTextSearch('test', 'i', 'foxers nopers', FullTextTermResolution.Or)
                            .then(res => {
                                assert.equal(res.length, 0);
                            });
                        const p21 = prov.fullTextSearch('test', 'i', 'fox)', FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 1);
                        });
                        const p22 = prov.fullTextSearch('test', 'i', 'fox*', FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 1);
                        });
                        const p23 = prov.fullTextSearch('test', 'i', 'fox* fox( <fox>', FullTextTermResolution.Or)
                            .then(res => {
                                assert.equal(res.length, 1);
                            });
                        const p24 = prov.fullTextSearch('test', 'i', 'f)ox', FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 0);
                        });
                        const p25 = prov.fullTextSearch('test', 'i', 'fo*x', FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 0);
                        });
                        const p26 = prov.fullTextSearch('test', 'i', 'tes>ter', FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 1);
                        });
                        const p27 = prov.fullTextSearch('test', 'i', 'f*x', FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 0);
                        });

                        const p28 = prov.fullTextSearch('test', 'i', 'бывает', FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 1);
                        });

                        const p29 = prov.fullTextSearch('test', 'i', '漁', FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 1);
                        });

                        const p30 = prov.fullTextSearch('test', 'i', '߂i18nDigits߂', FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 1);
                        });

                        // This is an empty string test. All special symbols will be replaced so this is technically empty string search.
                        const p31 = prov.fullTextSearch('test', 'i', '!@#$%$', FullTextTermResolution.Or).then(res => {
                            assert.equal(res.length, 0);
                        });

                        return SyncTasks.all([p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15, p16, p17, p18, p19, p20,
                            p21, p22, p23, p24, p25, p26, p27, p28, p29, p30, p31]).then(() => {
                                return prov.close();
                            });
                    });
                });
            });
        });
    });
});
