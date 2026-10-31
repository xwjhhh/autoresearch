// 只读终端输出的屏幕模型：把日志字节流按终端的方式“演”一遍，得到最终显示的每一行。
// 支持训练日志里常见的控制序列：\r 覆盖（tqdm 进度条）、光标上下移动（多条进度条）、擦除行、ANSI 颜色。
// 其余控制序列（窗口标题、清屏、绝对定位等）对日志没有意义，直接忽略。

export interface LogStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface LogSpan {
  text: string;
  style: number;
}

const basic = ["#2e3436", "#e06c6c", "#8fc97a", "#e5c07b", "#6fa8dc", "#c792ea", "#56c2c2", "#d3d7cf"];
const bright = ["#7c8988", "#ff8b8b", "#b5e890", "#ffd88a", "#9cc4f0", "#e0b0ff", "#8ee6e6", "#ffffff"];

function color256(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 8) return basic[index];
  if (index < 16) return bright[index - 8];
  if (index < 232) {
    const value = index - 16;
    const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    return `rgb(${level(Math.floor(value / 36))}, ${level(Math.floor(value / 6) % 6)}, ${level(value % 6)})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

interface Line {
  chars: string[];
  styles: number[];
}

export class LogScreen {
  /** 最多保留的行数，超过后丢掉最早的行。 */
  readonly maxLines: number;
  lines: Line[] = [{ chars: [], styles: [] }];
  /** 因为超过 maxLines 被丢掉的行数，用来换算行号。 */
  dropped = 0;
  /** 每次写入后加一，界面据此判断是否需要重绘。 */
  version = 0;
  private row = 0;
  private col = 0;
  private style: LogStyle = {};
  private styleId = 0;
  private styles: LogStyle[] = [{}];
  private styleKeys = new Map<string, number>([["{}", 0]]);
  private pending = "";

  constructor(maxLines = 50_000) {
    this.maxLines = maxLines;
  }

  reset() {
    this.lines = [{ chars: [], styles: [] }];
    this.dropped = 0;
    this.row = 0;
    this.col = 0;
    this.style = {};
    this.styleId = 0;
    this.pending = "";
    this.version += 1;
  }

  styleOf(id: number): LogStyle {
    return this.styles[id] ?? {};
  }

  /** 把一段已解码的文本写入屏幕。控制序列可以被切在两次写入之间。 */
  write(input: string) {
    const text = this.pending + input;
    this.pending = "";
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === "\u001b") {
        const consumed = this.escape(text, index);
        if (consumed < 0) { this.pending = text.slice(index); break; }
        index += consumed;
        continue;
      }
      index += 1;
      if (char === "\n") { this.newline(); continue; }
      if (char === "\r") { this.col = 0; continue; }
      if (char === "\b") { this.col = Math.max(0, this.col - 1); continue; }
      if (char === "\t") { const stop = (Math.floor(this.col / 8) + 1) * 8; while (this.col < stop) this.put(" "); continue; }
      const code = char.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) continue;
      this.put(char);
    }
    this.version += 1;
  }

  /** 返回消耗的字符数；序列不完整时返回 -1，等下一段数据。 */
  private escape(text: string, start: number): number {
    const next = text[start + 1];
    if (next === undefined) return -1;
    if (next === "[") {
      let end = start + 2;
      while (end < text.length && !/[@-~]/.test(text[end])) end += 1;
      if (end >= text.length) return text.length - start > 64 ? text.length - start : -1;
      this.csi(text.slice(start + 2, end), text[end]);
      return end - start + 1;
    }
    if (next === "]") {
      for (let end = start + 2; end < text.length; end += 1) {
        if (text[end] === "\u0007") return end - start + 1;
        if (text[end] === "\u001b" && text[end + 1] === "\\") return end - start + 2;
      }
      return text.length - start > 512 ? text.length - start : -1;
    }
    return 2;
  }

  private csi(raw: string, final: string) {
    const params = raw.replace(/^[?>=]/, "").split(";").map((part) => (part === "" ? NaN : Number(part)));
    const n = Number.isFinite(params[0]) && params[0] > 0 ? params[0] : 1;
    switch (final) {
      case "m": this.sgr(params); break;
      case "A": this.row = Math.max(0, this.row - n); break;
      case "B": this.row += n; this.ensureRow(); break;
      case "C": this.col += n; break;
      case "D": this.col = Math.max(0, this.col - n); break;
      case "G": this.col = n - 1; break;
      case "K": this.eraseLine(Number.isFinite(params[0]) ? params[0] : 0); break;
      default: break;
    }
  }

  private sgr(params: number[]) {
    const style = { ...this.style };
    const list = params.length ? params : [0];
    for (let index = 0; index < list.length; index += 1) {
      const code = Number.isFinite(list[index]) ? list[index] : 0;
      if (code === 0) { for (const key of Object.keys(style)) delete style[key as keyof LogStyle]; }
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 3) style.italic = true;
      else if (code === 4) style.underline = true;
      else if (code === 22) { delete style.bold; delete style.dim; }
      else if (code === 23) delete style.italic;
      else if (code === 24) delete style.underline;
      else if (code >= 30 && code <= 37) style.fg = basic[code - 30];
      else if (code >= 90 && code <= 97) style.fg = bright[code - 90];
      else if (code === 39) delete style.fg;
      else if (code >= 40 && code <= 47) style.bg = basic[code - 40];
      else if (code >= 100 && code <= 107) style.bg = bright[code - 100];
      else if (code === 49) delete style.bg;
      else if (code === 38 || code === 48) {
        const key = code === 38 ? "fg" : "bg";
        if (list[index + 1] === 5) { style[key] = color256(list[index + 2]); index += 2; }
        else if (list[index + 1] === 2) { style[key] = `rgb(${list[index + 2] | 0}, ${list[index + 3] | 0}, ${list[index + 4] | 0})`; index += 4; }
      }
    }
    for (const key of Object.keys(style) as Array<keyof LogStyle>) if (style[key] === undefined) delete style[key];
    this.style = style;
    const key = JSON.stringify(style, Object.keys(style).sort());
    let id = this.styleKeys.get(key);
    if (id === undefined) {
      id = this.styles.length;
      this.styles.push(style);
      this.styleKeys.set(key, id);
    }
    this.styleId = id;
  }

  private ensureRow() {
    while (this.lines.length <= this.row) this.lines.push({ chars: [], styles: [] });
    const extra = this.lines.length - this.maxLines;
    if (extra > 0) {
      this.lines.splice(0, extra);
      this.row -= extra;
      this.dropped += extra;
    }
  }

  private newline() {
    this.row += 1;
    this.col = 0;
    this.ensureRow();
  }

  private put(char: string) {
    const line = this.lines[this.row];
    while (line.chars.length < this.col) { line.chars.push(" "); line.styles.push(0); }
    line.chars[this.col] = char;
    line.styles[this.col] = this.styleId;
    this.col += 1;
  }

  private eraseLine(mode: number) {
    const line = this.lines[this.row];
    if (!line) return;
    if (mode === 2) { line.chars = []; line.styles = []; return; }
    if (mode === 1) { for (let index = 0; index <= Math.min(this.col, line.chars.length - 1); index += 1) { line.chars[index] = " "; line.styles[index] = 0; } return; }
    line.chars.length = Math.min(line.chars.length, this.col);
    line.styles.length = line.chars.length;
  }

  /** 当前保留的行数（末尾的空行不算）。 */
  get length() {
    let count = this.lines.length;
    while (count > 1 && this.lines[count - 1].chars.length === 0) count -= 1;
    return count;
  }

  /** 一行切成样式相同的片段，供渲染。 */
  spans(index: number): LogSpan[] {
    const line = this.lines[index];
    if (!line) return [];
    const spans: LogSpan[] = [];
    let text = "";
    let style = -1;
    for (let column = 0; column < line.chars.length; column += 1) {
      if (line.styles[column] !== style && text) { spans.push({ text, style }); text = ""; }
      style = line.styles[column];
      text += line.chars[column];
    }
    if (text) spans.push({ text, style });
    return spans;
  }

  text(index: number) {
    return this.lines[index]?.chars.join("") ?? "";
  }

  plainText() {
    return this.lines.slice(0, this.length).map((line) => line.chars.join("").trimEnd()).join("\n");
  }
}
