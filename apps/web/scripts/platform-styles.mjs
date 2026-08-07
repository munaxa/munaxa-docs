/**
 * The two pieces of string handling the stylesheet check depends on.
 *
 * Separated from the check itself because both got subtly wrong on the first attempt, and both
 * fail *open* — a bug here reports a healthy stylesheet rather than an error, which is the one
 * way a regression guard can be worse than no guard at all. They are unit-tested next door.
 */

/**
 * Is there a rule for this class in the stylesheet?
 *
 * Not a substring test, which is the trap: `.bg-primary` occurs inside `.bg-primary-strong`, and
 * `.bg-muted` inside `.bg-muted\/30`, so a plain `includes` reports a class as generated on the
 * strength of a *different* class that merely starts the same way.
 *
 * So the escaped selector must be followed by something that cannot continue a class name. `{`,
 * `,`, `:` and whitespace all qualify; `-`, an alphanumeric, and the backslash that begins
 * Tailwind's escape of `/` or `.` do not.
 *
 * @param {string} css The whole generated stylesheet.
 * @param {string} className An unescaped Tailwind class name.
 * @returns {boolean}
 */
export function hasRule(css, className) {
  const selector = toSelector(className);
  let from = 0;
  for (;;) {
    const at = css.indexOf(selector, from);
    if (at === -1) return false;
    const next = css[at + selector.length];
    if (next === undefined || !/[-_a-zA-Z0-9\\]/.test(next)) return true;
    from = at + 1;
  }
}

/**
 * How Tailwind escapes a class name when it writes it into a selector.
 *
 * @param {string} className
 * @returns {string}
 */
export function toSelector(className) {
  return `.${className.replace(/([.:/[\]()%&>#!,+*~^$@])/g, '\\$1')}`;
}

/**
 * Split a `className` string into class names.
 *
 * Whitespace separates classes *except* inside the brackets of an arbitrary value, where
 * `w-[min(36rem,90vw)]` and `grid-cols-[repeat(2,minmax(0,1fr))]` may legitimately contain both
 * commas and spaces. Splitting naively corrupts those into tokens that can never match, which
 * would make the check fail for a reason that has nothing to do with the platform.
 *
 * @param {string} value A `className` attribute's value.
 * @returns {string[]}
 */
export function splitClasses(value) {
  /** @type {string[]} */
  const out = [];
  let current = '';
  let depth = 0;
  for (const char of value) {
    if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    if (/\s/.test(char) && depth <= 0) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Keep the utilities out of a `className` string's tokens.
 *
 * Capitalised tokens are component names appearing in `clsx` argument objects, and a token
 * carrying a template hole is a fragment rather than a class.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isUtility(name) {
  return /^[a-z[]/.test(name) && !name.includes('${');
}
