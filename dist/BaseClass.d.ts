import { Options, LocalOptions, LocalHook, HOOKS, HooksContext } from './types';
export declare class BaseClass {
    name: string;
    hooks: LocalHook[];
    hooksContext: any;
    options: LocalOptions;
    constructor(options?: Options);
    log(text: string, type?: 'log' | 'error' | 'warn'): void;
    addContext(context: HooksContext): void;
    applyHooks(hookName: HOOKS): Promise<void>;
}
