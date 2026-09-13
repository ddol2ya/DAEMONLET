// 3.6 exports the documented synchronous tokenizer but omits its declaration.
import "stream-json/core/parser.js"
declare module "stream-json/core/parser.js" {
  export function jsonParser(options?: import("stream-json/core/parser.js").ParserOptions): import("stream-json/core/parser.js").TokenSource
}
declare module "stream-chain/defs.js" {
  interface Flushable<I, O> { (value: typeof import("stream-chain/defs.js").none): O }
}
