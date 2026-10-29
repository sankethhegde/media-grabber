// Short stable id from a string: two FNV-1a style 32-bit lanes → 16 hex chars.
// content/content-script.js keeps its own copy (content scripts can't import).
export function hash(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
