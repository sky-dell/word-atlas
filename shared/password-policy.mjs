export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_ERROR = '密码需8–128位，含大写、小写、数字和符号。';
export const PASSWORD_HINT = '8位起，含Aa、数字和符号';

// Length-only validation is deliberately separate: existing password hashes
// must remain usable after the rules for creating new passwords change.
export const validPasswordInput = value => typeof value === 'string' &&
  [...value].length >= PASSWORD_MIN_LENGTH && [...value].length <= PASSWORD_MAX_LENGTH;
export const validPassword = value => validPasswordInput(value) &&
  /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value) && /[\p{P}\p{S}]/u.test(value);
