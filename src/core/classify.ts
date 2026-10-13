/**
 * Decides whether a string written in code is text a person reads, or a code value (a URL, a class name, a CSS
 * value, an identifier, ...). Text in JSX and in known display attributes is always translated; this is for
 * strings found in data, props, ternaries and the like, where being wrong in either direction matters.
 */

const NOT_COPY_WORDS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "JSON", "UTF-8", "ASC", "DESC", "NULL", "TRUE", "FALSE",
  "LTR", "RTL", "CSS", "HTML", "NONE", "AUTO", "DEFAULT", "UNKNOWN", "ERROR", "SUCCESS", "WARNING", "INFO", "DEBUG",
]);

/** Letters in any script. */
const HAS_LETTER = /\p{L}/u;

/** A single token: no spaces. */
function singleToken(text: string): boolean {
  if (/^\p{Lu}\p{Ll}+$/u.test(text)) return true; // "Home", "Specs", "Über"
  if (/^\p{Lu}{2,}$/u.test(text) && !NOT_COPY_WORDS.has(text)) return true; // "FAQ", "OK", "NEW"
  if (/[^\x00-\x7f]/.test(text) && !/[_$\-./:]/.test(text) && !/\d/.test(text)) return true; // "你好", "Ñandú"
  return false; // primary, btnPrimary, snake_case, kebab-case, a.b.c, UPPER_SNAKE, file.png ...
}

export function looksLikeCopy(raw: string): boolean {
  const text = raw.trim();
  if (text.length < 2 || !HAS_LETTER.test(text)) return false;

  // Addresses and files
  if (/^(?:https?:|ftp:|mailto:|tel:|sms:|data:|blob:|file:|javascript:|\/\/|\/|\.{1,2}\/|#|@|~\/)/i.test(text)) return false;
  if (/:\/\//.test(text)) return false;
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(text)) return false; // email
  if (!/\s/.test(text) && /^[\w\-./@]+\.[a-z0-9]{1,5}$/i.test(text)) return false; // image.png, data.json
  if (/^[a-z]+\/[a-z0-9.+-]+$/i.test(text)) return false; // application/json
  if (/^[a-z]{2,3}-[A-Z][A-Za-z]{1,3}$/.test(text)) return false; // en-US, zh-Hans

  // CSS, SVG and code
  if (/^(?:rgba?|hsla?|var|calc|url|translate[XYZ3d]*|rotate[XYZ]?|scale[XYZ]?|matrix|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|steps|polygon|inset|circle|ellipse)\(/i.test(text)) return false;
  if (/(?:sans-serif|serif|monospace|system-ui|cursive)\b/i.test(text)) return false; // font stacks
  if (/^[\d.]+(?:px|rem|em|vh|vw|vmin|vmax|ms|s|deg|fr|ch|pt|cm|mm)(?:\s|$)/i.test(text)) return false;
  if (/^[MmLlHhVvCcSsQqTtAaZz]\s*-?[\d.]/.test(text)) return false; // SVG path data
  if (/[\w-]+\s*:\s*[^;]+;/.test(text)) return false; // "color: red;"
  if (/=>|<\/?[a-z][\w-]*[\s>/]|\{\s*\}|\(\s*\)\s*;|^function\b|^import\s|^const\s/.test(text)) return false; // code and markup
  if (/^[YMDHhmsaAZ\-/:.\s,]+$/.test(text)) return false; // date format tokens

  // One word ("Loading...", "Saved!", "Name:" are text; strip the punctuation around it before judging the word)
  if (!/\s/.test(text)) return singleToken(text.replace(/^[("“'\[]+|[.…!?:;,)"”'\]]+$/g, ""));

  // Several words: a class list ("flex items-center", "btn btn-primary") is all lowercase tokens with code-ish bits
  const tokens = text.split(/\s+/);
  if (tokens.every((w) => /^[a-z][a-z0-9_:\-\/\[\].%!#]*$/.test(w)) && tokens.some((w) => /[-:_\[\]\/%!#\d]/.test(w))) return false;
  // Two or three code-looking words ("btnPrimary btnLarge", "my_var other_var"); a brand word inside a sentence is not code
  if (tokens.length <= 3 && tokens.every((w) => /^[a-z][a-z0-9]*$|[a-z][A-Z]|_/.test(w) && /^[A-Za-z_$][\w$.]*$/.test(w)) && tokens.some((w) => /[a-z][A-Z]|_/.test(w))) return false;
  return true;
}

/** Attributes on any element or component whose value is code, never text. */
export const NON_DISPLAY_ATTRS = new Set([
  "className", "class", "classes", "style", "id", "key", "ref", "href", "src", "srcSet", "srcset", "to", "path", "htmlFor",
  "type", "rel", "target", "method", "action", "lang", "dir", "charSet", "value", "defaultValue",
  "checked", "d", "viewBox", "fill", "stroke", "transform", "xmlns", "width", "height", "size", "variant", "color",
  "align", "position", "mode", "kind", "intent", "tone", "as", "icon", "iconName", "image", "img", "src2",
  "autoComplete", "inputMode", "accept", "pattern", "media", "sizes", "loading", "crossOrigin", "decoding", "preserveAspectRatio",
  "fontFamily", "queryKey", "testId", "locale", "format", "selector", "event",
]);
/** Object keys whose value is code, never text. */
export const NON_COPY_KEYS = new Set([...NON_DISPLAY_ATTRS, "url", "uri", "route", "slug", "logo", "bg", "background", "colour", "font",
  "transition", "animation", "display", "cursor", "overflow", "justify", "points", "mask", "filter", "clipPath", "mime", "regex",
  "hash", "token", "secret", "apiKey", "env", "mutationKey", "values", "option", "initialValue", "labelKey", "valueKey", "imageUrl"]);
