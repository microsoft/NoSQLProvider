declare interface Promise<T> {
    always: <U>(func: (value: T | any) => U | PromiseLike<U>) => Promise<U>;
}