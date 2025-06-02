(globalThis as any).$DD_ALLOW = new Set();
(globalThis as any).$DD_ALLOW_OBSERVERS = new Set();

export function $(newValues: string[] | TemplateStringsArray) {
    const initialSize = (globalThis as any).$DD_ALLOW.size;

    newValues.forEach((value) => (globalThis as any).$DD_ALLOW.add(value));

    if ((globalThis as any).$DD_ALLOW.size !== initialSize) {
        (globalThis as any).$DD_ALLOW_OBSERVERS.forEach((cb: () => void) => cb());
    }

    return newValues;
}
