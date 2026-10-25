'use strict';

// A data-only Lua table reader. Never evaluate JCL text as JavaScript or Lua.
class LuaReader {
  constructor(text) { this.text = text; this.pos = 0; this.depth = 0; }
  space() { while (/\s/.test(this.text[this.pos] || '\0')) this.pos++; }
  fail(message) { throw new Error(`${message} (offset ${this.pos})`); }
  take(token) {
    this.space();
    if (!this.text.startsWith(token, this.pos)) this.fail(`Expected ${token}`);
    this.pos += token.length;
  }
  value() {
    this.space();
    const char = this.text[this.pos];
    if (char === '{') return this.table();
    if (char === '"' || char === "'") return this.string();
    const rest = this.text.slice(this.pos);
    const keyword = /^(true|false|nil)\b/.exec(rest);
    if (keyword) { this.pos += keyword[0].length; return { true: true, false: false, nil: null }[keyword[0]]; }
    const number = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest);
    if (number) {
      this.pos += number[0].length;
      const value = Number(number[0]);
      if (!Number.isFinite(value)) this.fail('Non-finite number');
      // Preserve long GUIDs exactly, including in logs that do not quote them.
      return Number.isInteger(value) && !Number.isSafeInteger(value) ? number[0] : value;
    }
    this.fail('Unsupported Lua literal');
  }
  string() {
    const quote = this.text[this.pos++];
    let out = '';
    const escapes = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" };
    while (this.pos < this.text.length) {
      let char = this.text[this.pos++];
      if (char === quote) return out;
      if (char === '\\') {
        char = this.text[this.pos++];
        if (/\d/.test(char || '')) {
          let digits = char;
          while (digits.length < 3 && /\d/.test(this.text[this.pos] || '')) digits += this.text[this.pos++];
          const value = Number(digits);
          if (value > 255) this.fail('Invalid Lua byte escape');
          out += String.fromCharCode(value);
        } else if (Object.hasOwn(escapes, char)) out += escapes[char];
        else this.fail('Unsupported string escape');
      } else out += char;
    }
    this.fail('Unterminated string');
  }
  table() {
    if (++this.depth > 64) this.fail('Table nesting limit exceeded');
    this.take('{');
    const result = Object.create(null);
    let next = 1;
    for (;;) {
      this.space();
      if (this.text[this.pos] === '}') { this.pos++; this.depth--; return result; }
      let key;
      if (this.text[this.pos] === '[') {
        this.pos++; key = this.value(); this.take(']'); this.take('=');
        if (!['number', 'string'].includes(typeof key)) this.fail('Invalid table key');
      } else {
        const named = /^([A-Za-z_][A-Za-z_0-9]*)\s*=/.exec(this.text.slice(this.pos));
        if (named) { key = named[1]; this.pos += named[0].length; }
        else key = next++;
      }
      if (Object.hasOwn(result, key)) this.fail('Duplicate table key');
      result[key] = this.value();
      this.space();
      if (this.text[this.pos] === ',' || this.text[this.pos] === ';') this.pos++;
      else if (this.text[this.pos] !== '}') this.fail('Expected table separator');
    }
  }
  parse() {
    const result = this.value();
    this.space();
    if (this.pos !== this.text.length) this.fail('Trailing executable or unsupported content');
    return result;
  }
}

function decodeJcl(input) {
  if (typeof input === 'string') return { text: input.replace(/^\uFEFF/, ''), encoding: 'string' };
  const bytes = new Uint8Array(input);
  const candidates = bytes[0] === 0xff && bytes[1] === 0xfe ? ['utf-16le']
    : bytes[0] === 0xfe && bytes[1] === 0xff ? ['utf-16be'] : ['utf-8', 'gb18030'];
  for (const encoding of candidates) {
    try { return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding }; } catch { /* Try next decoder. */ }
  }
  throw new Error('JCL 编码无法识别，支持 UTF-8、GB18030 和带 BOM 的 UTF-16。');
}

function parseJcl(input) {
  const { text, encoding } = decodeJcl(input);
  const events = [], errors = [];
  let totalErrors = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      if (lines[i].length > 2_000_000) throw new Error('Single-record size limit exceeded');
      const columns = lines[i].split('\t');
      if (columns.length < 6 || !columns.slice(0, 5).every(x => /^\d+$/.test(x))) throw new Error('Expected five numeric columns and a Lua table');
      const [crc, frame, unix, ms, event] = columns.slice(0, 5).map(Number);
      if (![crc, frame, unix, ms, event].every(Number.isSafeInteger)) throw new Error('Unsafe numeric column');
      const data = new LuaReader(columns.slice(5).join('\t')).parse();
      if (!data || typeof data !== 'object') throw new Error('Event payload must be a table');
      events.push({ line: i + 1, crc, frame, unix, ms, event, data });
    } catch (error) {
      totalErrors++;
      if (errors.length < 20) errors.push({ line: i + 1, message: error.message });
    }
  }
  if (!events.length) throw new Error('文件中没有可读取的 JCL 事件。');
  return { events, encoding, totalErrors, errors, lineCount: lines.length - (lines.at(-1) === '' ? 1 : 0) };
}

module.exports = { LuaReader, decodeJcl, parseJcl };
