/**
 * TransactionLockHelper.ts
 * Author: David de Regt
 * Copyright: Microsoft 2017
 *
 * Several of the different providers need various types of help enforcing exclusive/readonly transactions.  This helper keeps
 * store-specific lock info and releases transactions at the right time, when the underlying provider can't handle it.
 */
import { DbSchema } from './NoSqlProvider';
export interface TransactionToken {
    readonly completionPromise: Promise<void>;
    readonly storeNames: string[];
    readonly exclusive: boolean;
}
export declare class Deferred<T> {
    private _promise;
    private _reject;
    private _resolve;
    constructor();
    readonly promise: Promise<T>;
    resolve(value?: T | PromiseLike<T> | undefined): void;
    reject(reason?: any): void;
}
export declare class TransactionLockHelper {
    private _schema;
    private _supportsDiscreteTransactions;
    private _closingDefer;
    private _closed;
    private _exclusiveLocks;
    private _readOnlyCounts;
    private _pendingTransactions;
    constructor(_schema: DbSchema, _supportsDiscreteTransactions: boolean);
    closeWhenPossible(): Promise<void>;
    private _checkClose;
    hasTransaction(): boolean;
    openTransaction(storeNames: string[] | undefined, exclusive: boolean): Promise<TransactionToken>;
    transactionComplete(token: TransactionToken): void;
    transactionFailed(token: TransactionToken, message: string): void;
    private _cleanTransaction;
    private _checkNextTransactions;
}
