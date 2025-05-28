const $DD_ALLOW: Set<string> = new Set();
const $DD_ALLOW_OBSERVERS: Set<() => void> = new Set();

export function enrichAllowlist(newValues: string[] | TemplateStringsArray) {
    const initialSize = $DD_ALLOW.size;

    newValues.forEach((value) => $DD_ALLOW.add(value));

    if ($DD_ALLOW.size !== initialSize) {
        $DD_ALLOW_OBSERVERS.forEach((cb) => cb());
    }
}
