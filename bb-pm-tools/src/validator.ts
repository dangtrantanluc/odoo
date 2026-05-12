export function assertPositiveInteger(value: unknown, name: string): asserts value is number {
    if (!Number.isInteger(value) || Number(value) <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
}

export function assertNonNegativeInt(value: unknown, name: string): asserts value is number {
    if (!Number.isInteger(value) || Number(value) < 0) {
        throw new Error(`${name} must be a non-negative integer.`);
    }
}