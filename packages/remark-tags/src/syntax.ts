import type { Code, Extension, State, Tokenizer } from "micromark-util-types";
import type { TagDeclarations, TagSyntaxOptions } from "./types.js";
import { validateDeclarations } from "./grammar.js";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    topikTextTag: "topikTextTag";
    topikFlowTag: "topikFlowTag";
  }
}

// Micromark represents tabs/virtual spaces as -2/-1 and line endings as -5..-3.
const horizontal = (code: Code) => code === 32 || code === -2 || code === -1;
const lineEnd = (code: Code) => code === null || code < -2;
const lower = (code: Code) => code !== null && code >= 97 && code <= 122;
const nameCharacter = (code: Code) =>
  code !== null &&
  (lower(code) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 45);

/** Recognize markers without consuming the Markdown between paired tags. */
export function tagSyntax(
  declarations: TagDeclarations,
  options: TagSyntaxOptions = {},
): Extension {
  validateDeclarations(declarations, options);
  return {
    flow: {
      123: options.expressions
        ? [{ tokenize: codeTemplateTokenizer }, { tokenize: tokenizer(true) }]
        : { tokenize: tokenizer(true) },
    },
    text: { 123: { tokenize: tokenizer(false) } },
  };

  // Speculate on the complete special head before ordinary declaration placement.
  // Reserving the name alone would break custom inline `template` components.
  function codeTemplateTokenizer(
    effects: Parameters<Tokenizer>[0],
    ok: Parameters<Tokenizer>[1],
    nok: Parameters<Tokenizer>[2],
  ): ReturnType<Tokenizer> {
    let word = "template";
    let index = 0;
    return start;
    function start(code: Code): State | undefined {
      effects.enter("topikFlowTag");
      effects.consume(code);
      return percent;
    }
    function percent(code: Code): State | undefined {
      if (code !== 37) return nok(code);
      effects.consume(code);
      return beforeWord;
    }
    function beforeWord(code: Code): State | undefined {
      if (horizontal(code)) {
        effects.consume(code);
        return beforeWord;
      }
      if (code === 47) {
        effects.consume(code);
        return name;
      }
      return name(code);
    }
    function name(code: Code): State | undefined {
      if (code !== word.charCodeAt(index)) return nok(code);
      effects.consume(code);
      if (++index < word.length) return name;
      return word === "template" ? separator : afterCode;
    }
    function separator(code: Code): State | undefined {
      if (!horizontal(code)) return nok(code);
      effects.consume(code);
      word = "code";
      index = 0;
      return beforeCode;
    }
    function beforeCode(code: Code): State | undefined {
      if (horizontal(code)) {
        effects.consume(code);
        return beforeCode;
      }
      return name(code);
    }
    function afterCode(code: Code): State | undefined {
      if (horizontal(code)) {
        effects.consume(code);
        return afterCode;
      }
      if (code !== 37) return nok(code);
      effects.consume(code);
      return close;
    }
    function close(code: Code): State | undefined {
      if (code !== 125) return nok(code);
      effects.consume(code);
      return tail;
    }
    function tail(code: Code): State | undefined {
      if (horizontal(code)) {
        effects.consume(code);
        return tail;
      }
      if (!lineEnd(code)) return nok(code);
      effects.exit("topikFlowTag");
      return ok(code);
    }
  }

  function tokenizer(flow: boolean): Tokenizer {
    return (effects, ok, nok) => {
      const token = flow ? "topikFlowTag" : "topikTextTag";
      let name = "";
      let quote: Code = null;
      let escaped = false;
      let percent = false;
      return start;

      function start(code: Code): State | undefined {
        if (code !== 123) return nok(code);
        effects.enter(token);
        effects.consume(code);
        return openPercent;
      }

      function openPercent(code: Code): State | undefined {
        if (code !== 37) return nok(code);
        effects.consume(code);
        return flow ? beforeName : body;
      }

      function beforeName(code: Code): State | undefined {
        if (horizontal(code)) {
          effects.consume(code);
          return beforeName;
        }
        if (code === 47) {
          effects.consume(code);
          return nameStart;
        }
        return nameStart(code);
      }

      function nameStart(code: Code): State | undefined {
        if (!lower(code)) return nok(code);
        return nameRest(code);
      }

      function nameRest(code: Code): State | undefined {
        if (nameCharacter(code)) {
          name += String.fromCharCode(code!);
          effects.consume(code);
          return nameRest;
        }
        // Decline inline names before Markdown makes a block, so an inline tag
        // on its own line remains part of the surrounding paragraph.
        const conditional = options.expressions && (name === "if" || name === "else");
        if (
          !conditional &&
          (!Object.hasOwn(declarations, name) || declarations[name].kind !== "block")
        )
          return nok(code);
        return body(code);
      }

      function body(code: Code): State | undefined {
        if (lineEnd(code)) {
          if (flow) return nok(code);
          // Keep malformed openers as markers; the reader reports their source
          // location instead of silently treating them as ordinary text.
          effects.exit(token);
          return ok(code);
        }
        if (code === 125 && percent && quote === null) {
          effects.consume(code);
          if (flow) return tail;
          effects.exit(token);
          return ok;
        }
        if (escaped) escaped = false;
        else if (quote !== null && code === 92) escaped = true;
        else if (code === quote) quote = null;
        else if (quote === null && (code === 34 || code === 39)) quote = code;
        percent = code === 37 && quote === null;
        effects.consume(code);
        return body;
      }

      function tail(code: Code): State | undefined {
        if (horizontal(code)) {
          effects.consume(code);
          return tail;
        }
        if (!lineEnd(code)) return nok(code);
        effects.exit(token);
        return ok(code);
      }
    };
  }
}
