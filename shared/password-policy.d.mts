export const PASSWORD_MIN_LENGTH: 8;
export const PASSWORD_MAX_LENGTH: 128;
export const PASSWORD_ERROR: string;
export const PASSWORD_HINT: string;
export function validPasswordInput(value: unknown): value is string;
export function validPassword(value: unknown): value is string;
