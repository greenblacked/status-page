/**
 * The visible text of server-rendered markup: everything outside a `<...>` tag.
 *
 * A single pass over the characters, not a regex replace, so there is no
 * second pass to leave a half-removed tag behind (`<scr<b>ipt>`): a `<` opens
 * a tag and the next `>` closes it, whatever sits between. React escapes a
 * literal `<` in text as `&lt;`, so a bare one only ever starts a tag.
 */
export function visibleText(html: string): string {
  let out = "";
  let inTag = false;
  for (const char of html) {
    if (inTag) {
      if (char === ">") inTag = false;
    } else if (char === "<") {
      inTag = true;
    } else {
      out += char;
    }
  }
  return out;
}
