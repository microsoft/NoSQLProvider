/**
 * This file contains a series of promise polyfills that help with making promises 
 * work on legacy platforms see https://caniuse.com/promises for a full list of 
 * browsers where this can be used. 
 * 
 * NOTE: Promise.finally is added to the ES standard but is only available on more
 * recent versions https://caniuse.com/mdn-javascript_builtins_promise_finally
 * 
 * The fila lso adds support for Promise.always (NOT ES compliant). The difference between
 * finally and always is, always will always rethrow the exception thrown in the catch(). 
 * 
 * How to import this file: 
 * As this file contains polyfills and added type definitions you would need to import it with side-effects
 * import "./Promise.extensions" 
 * not doing so will prevent the polyfills from being imported.
 * 
 * Additionally, make sure this file is imported as part of the index.ts (entry-point) for your bundle/chunk
 * to make sure all Promise prototypes are correctly patched.
 * 
 * NOTE: You do not need to do anything to import this file when importing NoSQLProvider... this file is 
 * automatically included for NoSQLProvider as part of NoSQLProvider.ts which is the main entry-point for this package
 */
import 'core-js/features/promise';
import 'core-js/features/promise/finally';
import { getWindow } from './get-window';

/**
 * Below is a polyfill for Promise.always
 */
if (!Promise.prototype.always) {
    Promise.prototype.always = function (onResolveOrReject) {
        return this.then(onResolveOrReject,
            function (reason: any) {
                onResolveOrReject(reason);
                throw reason;
            });
    };
}

export interface PromiseConfig {
    // If we catch exceptions in success/fail blocks, it silently falls back to the fail case of the outer promise.
    // If this is global variable is true, it will also spit out a console.error with the exception for debugging.
    exceptionsToConsole: boolean;

    // Whether or not to actually attempt to catch exceptions with try/catch blocks inside the resolution cases.
    // Disable this for debugging when you'd rather the debugger caught the exception synchronously rather than
    // digging through a stack trace.
    catchExceptions: boolean;

    // Regardless of whether an exception is caught or not, this will always execute.
    exceptionHandler: ((ex: Error) => void) | undefined;

    // If an ErrorFunc is not added to the task (then, catch, always) before the task rejects or synchonously
    // after that, then this function is called with the error. Default throws the error.
    unhandledErrorHandler: (err: any) => void;
}

let boundRejectionHandledListener: (e: PromiseRejectionEvent) => void;
let boundUnhandledRejectionListener: (e: PromiseRejectionEvent) => void;

/**
 * This function provides a way to override the default handling behavior for ES6 promises
 * @param config various configuration options for this.
 */
export function registerPromiseGlobalHandlers(config: PromiseConfig) {
    boundRejectionHandledListener = (e: PromiseRejectionEvent) => {
        if (config.exceptionsToConsole) {
            console.error('handled', e.reason, e.promise);
        }

        if (config.exceptionHandler) {
            config.exceptionHandler(e.reason);
        }
    };
    boundUnhandledRejectionListener = (e: PromiseRejectionEvent) => {
        if (config.exceptionsToConsole) {
            console.error('unhandled', e.reason, e.promise);
        }

        if (config.catchExceptions) {
            e.preventDefault();
        }
        config.unhandledErrorHandler(e.reason);
    };
    getWindow().addEventListener('rejectionhandled', boundRejectionHandledListener);

    getWindow().addEventListener('unhandledrejection', boundUnhandledRejectionListener);
}

/**
 * This function provides a way to unregister global listeners for promises.
 * @param config various configuration options for this.
 */
export function unRegisterPromiseGlobalHandlers() {
    getWindow().removeEventListener('rejectionhandled', boundRejectionHandledListener);

    getWindow().removeEventListener('unhandledrejection', boundUnhandledRejectionListener);
}
