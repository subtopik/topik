import type { Code, Extension, State, Tokenizer } from "micromark-util-types";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    topikJsxFlowBoundary: "topikJsxFlowBoundary";
  }
}

// Micromark supplies logical flow positions after list/quote prefixes, with
// tabs/virtual spaces as -2/-1 and line endings as -5..-3.
const horizontal = (code: Code) => code === 32 || code === -2 || code === -1;
const lineEnd = (code: Code) => code === null || code < -2;
const nameCharacter = (code: Code) =>
  code !== null &&
  ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57));

/** Standalone block-component headers delimit Markdown bodies, without hiding them. */
export function jsxBoundarySyntax(names: ReadonlySet<string>): Extension {
  const longestName = Math.max(...[...names].map((name) => name.length));
  const tokenize: Tokenizer = (effects, ok, nok) => {
    let name = "";
    let quote: Code = null;
    let escaped = false;
    let braces = 0;
    return start;

    function start(code: Code): State | undefined {
      if (code !== 60) return nok(code);
      effects.enter("topikJsxFlowBoundary");
      effects.consume(code);
      return slash;
    }

    function slash(code: Code): State | undefined {
      if (code === 47) {
        effects.consume(code);
        return nameStart;
      }
      return nameStart(code);
    }

    function nameStart(code: Code): State | undefined {
      if (code === null || code < 65 || code > 90) return nok(code);
      name = "";
      return nameRest(code);
    }

    function nameRest(code: Code): State | undefined {
      if (nameCharacter(code)) {
        name += String.fromCharCode(code!);
        if (name.length > longestName) return nok(code);
        effects.consume(code);
        return nameRest;
      }
      if (!names.has(name) || !(horizontal(code) || lineEnd(code) || code === 62 || code === 47))
        return nok(code);
      return attributes(code);
    }

    function attributes(code: Code): State | undefined {
      // A new unquoted tag cannot belong to this header. Quoted newlines and
      // multiline expressions are unsupported by the migration's attribute
      // reader. Decline them here instead of repeatedly scanning later lines.
      if (
        code === null ||
        (lineEnd(code) && (quote !== null || braces > 0)) ||
        (code === 60 && quote === null && braces === 0)
      )
        return nok(code);
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (code === 92) escaped = true;
        else if (code === quote) quote = null;
      } else if (code === 34 || code === 39) quote = code;
      else if (code === 123) braces++;
      else if (code === 125 && braces > 0) braces--;
      else if (code === 62 && braces === 0) {
        effects.consume(code);
        effects.exit("topikJsxFlowBoundary");
        return tail;
      }
      effects.consume(code);
      return attributes;
    }

    function tail(code: Code): State | undefined {
      if (horizontal(code)) {
        effects.enter("whitespace");
        return whitespace(code);
      }
      // Adjacent headers, such as <Tabs><Tab>, share a flow boundary. A body
      // on this line keeps the entire construct in the normal inline grammar.
      if (code === 60) return start(code);
      return lineEnd(code) ? ok(code) : nok(code);
    }

    function whitespace(code: Code): State | undefined {
      if (horizontal(code)) {
        effects.consume(code);
        return whitespace;
      }
      effects.exit("whitespace");
      return tail(code);
    }
  };
  return { flow: { 60: { tokenize } } };
}
