declare module "mdast" {
  interface HeadingData {
    topikId?: string;
    hProperties?: { id?: string };
  }
}
import type { Heading } from "mdast";
import type { Extension as ReaderExtension } from "mdast-util-from-markdown";
import { defaultHandlers, type Options, type State, type Info } from "mdast-util-to-markdown";
import type { Extension, State as TokenState, Tokenizer } from "micromark-util-types";
import type { TreeNode } from "./model.js";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    topikHeadingId: "topikHeadingId";
  }
}

const validId = /^[A-Za-z0-9_.:-]+$/;

/** An independent inline construct, claimed before generic tag tokenization. */
export function headingIdSyntax(): Extension {
  const tokenize: Tokenizer = (effects, ok, nok) => {
    let value = "";
    return start;
    function start(code: number | null): TokenState | undefined {
      if (code !== 123) return nok(code);
      effects.enter("topikHeadingId");
      effects.consume(code);
      return percent;
    }
    function percent(code: number | null): TokenState | undefined {
      if (code !== 37) return nok(code);
      effects.consume(code);
      return hash;
    }
    function hash(code: number | null): TokenState | undefined {
      if (code === 32 || code === -2 || code === -1) {
        effects.consume(code);
        return hash;
      }
      if (code !== 35) return nok(code);
      effects.consume(code);
      return id;
    }
    function id(code: number | null): TokenState | undefined {
      if (code !== null && code > 0 && /^[A-Za-z0-9_.:-]$/.test(String.fromCharCode(code))) {
        value += String.fromCharCode(code);
        effects.consume(code);
        return id;
      }
      if (!value) return nok(code);
      return closePercent(code);
    }
    function closePercent(code: number | null): TokenState | undefined {
      if (code === 32 || code === -2 || code === -1) {
        effects.consume(code);
        return closePercent;
      }
      if (code !== 37) return nok(code);
      effects.consume(code);
      return close;
    }
    function close(code: number | null): TokenState | undefined {
      if (code !== 125) return nok(code);
      effects.consume(code);
      effects.exit("topikHeadingId");
      return ok;
    }
  };
  return { text: { 123: { tokenize } } };
}

export function headingIdFromMarkdown(): ReaderExtension {
  return {
    enter: {
      topikHeadingId(token) {
        const value = this.sliceSerialize(token).slice(2, -2).trim().slice(1);
        this.enter({ type: "topikHeadingId", value } as never, token);
      },
    },
    exit: {
      topikHeadingId(token) {
        this.exit(token);
      },
    },
    transforms: [
      (root) => {
        function walk(node: TreeNode): void {
          for (const child of node.children ?? []) walk(child);
          if (node.type !== "heading") return;
          const marker = node.children?.at(-1);
          if (marker?.type !== "topikHeadingId") return;
          const heading = node as unknown as Heading;
          heading.data = { ...heading.data, topikId: marker.value };
          heading.children.pop();
          const preceding = heading.children.at(-1);
          if (preceding?.type === "text") {
            preceding.value = preceding.value.replace(/[ \t]+$/, "");
            if (!preceding.value) heading.children.pop();
          }
        }
        walk(root);
        return root;
      },
    ],
  };
}

export function headingIdToMarkdown(): NonNullable<Options["extensions"]>[number] {
  return {
    handlers: {
      heading(node: Heading, parent: unknown, state: State, info: Info): string {
        const id = node.data?.topikId;
        if (id === undefined) return defaultHandlers.heading(node, parent as never, state, info);
        if (typeof id !== "string" || !validId.test(id)) throw new Error("Invalid heading ID");
        const children = [...node.children];
        if (children.length) children.push({ type: "text", value: " " });
        children.push({ type: "topikHeadingId", value: id } as never);
        return defaultHandlers.heading({ ...node, children }, parent as never, state, info);
      },
      topikHeadingId(node: { value: string }): string {
        return `{% #${node.value} %}`;
      },
    },
  } as NonNullable<Options["extensions"]>[number];
}
