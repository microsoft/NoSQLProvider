declare interface Promise<T> {
    finally: (value: T | any) => Promise<T | any>;
    always: <U>(func: (value: T | any) => U | PromiseLike<U>) => Promise<U>;
}
