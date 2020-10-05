export interface IDeferred<T> {
    promise: Promise<T>;
    resolve<T>(value: T | PromiseLike<T>): void;
    resolve(): void;
    reject(reason: unknown): void;
}

export function defer<T>(): IDeferred<T> {
    const deferred: Partial<IDeferred<T>> = {};
    // eslint-disable-next-line msteams/promise-must-complete
    deferred.promise = new Promise<T>((resolve, reject) => {
        deferred.resolve = resolve;
        deferred.reject = reject;
    });
    return deferred as IDeferred<T>;
}
