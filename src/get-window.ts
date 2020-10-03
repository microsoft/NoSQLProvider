/**
     * Gets global window object - whether operating in worker or UI thread context.
     * Adapted from: https://stackoverflow.com/questions/7931182/reliably-detect-if-the-script-is-executing-in-a-web-worker
     */
export function getWindow() {
    if (typeof window === 'object' && window.document) {
        return window;
    } else if (self && self.document === undefined) {
        return self;
    }

    throw new Error('Undefined context');
}