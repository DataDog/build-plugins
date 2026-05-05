declare module 'estree-walker' {
    import type { Node } from 'estree';

    type WalkerContext = {
        skip(): void;
        remove(): void;
        replace(node: Node): void;
    };

    export function walk<T extends Node>(
        ast: T,
        walker: {
            enter?(this: WalkerContext, node: Node, parent: Node, key: string, index: number): void;
            leave?(this: WalkerContext, node: Node, parent: Node, key: string, index: number): void;
        },
    ): T;
}
