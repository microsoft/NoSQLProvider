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
    exceptionsToConsole: boolean,

    // Whether or not to actually attempt to catch exceptions with try/catch blocks inside the resolution cases.
    // Disable this for debugging when you'd rather the debugger caught the exception synchronously rather than
    // digging through a stack trace.
    catchExceptions: boolean,

    // Regardless of whether an exception is caught or not, this will always execute.
    exceptionHandler: ((ex: Error) => void) | undefined,

    // If an ErrorFunc is not added to the task (then, catch, always) before the task rejects or synchonously
    // after that, then this function is called with the error. Default throws the error.
    unhandledErrorHandler: (err: any) => void,
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
            console.error('handled', e.reason, e.promise)
        }

        if (config.exceptionHandler) {
            config.exceptionHandler(e.reason);
        }
    };
    boundUnhandledRejectionListener = (e: PromiseRejectionEvent) => {
        if (config.exceptionsToConsole) {
            console.error('unhandled', e.reason, e.promise)
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
 * This function provides a way to unregister global listeners
 * @param config various configuration options for this.
 */
export function unRegisterPromiseGlobalHandlers() {
    getWindow().removeEventListener('rejectionhandled', boundRejectionHandledListener);

    getWindow().removeEventListener('unhandledrejection', boundUnhandledRejectionListener);
}
