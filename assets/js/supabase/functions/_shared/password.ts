// Random temp password generator that satisfies the schema's
// assert_password_policy: 10-16 chars, charset [A-Za-z0-9!@#$%^&*._-], must
// contain at least one uppercase, lowercase, digit, and approved symbol.

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // omit I, O for legibility
const LOWER = "abcdefghjkmnpqrstuvwxyz"; // omit i, l, o
const DIGIT = "23456789"; // omit 0, 1
const SYMBOL = "!@#$%^&*._-";
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

function pick(charset: string): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return charset.charAt(buf[0] % charset.length);
}

export function generateTempPassword(length = 12): string {
  if (length < 10 || length > 16) {
    throw new Error("Temp password length must be 10-16.");
  }
  // Guarantee one of each class, then fill, then shuffle.
  const chars: string[] = [
    pick(UPPER),
    pick(LOWER),
    pick(DIGIT),
    pick(SYMBOL),
  ];
  for (let i = chars.length; i < length; i++) chars.push(pick(ALL));

  // Fisher-Yates shuffle using crypto-random indices.
  for (let i = chars.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
