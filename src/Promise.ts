declare interface Promise<T> {
    finally: (value: T | any) => Promise<T | any>;
    always: <U>(func: (value: T | any) => U | PromiseLike<U>) => Promise<U>;
}

Promise.prototype.finally = function (onResolveOrReject) {
    return this.catch(function (reason) {
        return reason;
    }).then(onResolveOrReject);
};
Promise.prototype.always = function (onResolveOrReject) {
    return this.then(onResolveOrReject,
        function (reason) {
            onResolveOrReject(reason);
            throw reason;
        });
};
