import type { Options } from "mdast-util-to-markdown";
import { writeTextTemplate } from "@topik/remark-tags";
import type { TreeNode } from "./model.js";
import { serializeCodePresentationMetadata } from "./code-presentation.js";
import { ordinaryCodeFenceLength } from "./code-writer.js";
import { assertSourceLimit } from "./limits.js";

/** Header source has already been encoded for exactly one CommonMark decoding pass. */
export function codePresentationWriterExtension(): Options {
  return {
    handlers: {
      topikCodePresentation(node) {
        const presentation = node as unknown as TreeNode;
        const child = presentation.children![0];
        const templated = child.type === "tagCodeTemplate";
        const value = templated ? writeTextTemplate(child.template!, true) : child.value!;
        const metadata = serializeCodePresentationMetadata(
          presentation.options!,
          presentation.opaqueMetaSuffix!,
        );
        const ticks = ordinaryCodeFenceLength(value);
        const tildes = ordinaryCodeFenceLength(value, "~");
        const marker = child.lang?.includes("`") || tildes < ticks ? "~" : "`";
        const fence = marker.repeat(marker === "`" ? ticks : tildes);
        let language = (child.lang ?? "").replace(/[&\\`]/g, (unit) => `&#${unit.charCodeAt(0)};`);
        // Keep literal language names distinct from language-less option headers.
        if (
          /^(?:lines|wrap)$|^(?:filename|title|lines|startLine|highlight|focus|collapseAfter|wrap|added|removed)=/.test(
            language,
          )
        )
          language = `&#${language.charCodeAt(0)};${language.slice(1)}`;
        const body = `${fence}${language}${language ? " " : ""}${metadata}\n${value ? `${value}\n` : ""}${fence}`;
        const scope = templated ? `{% template code %}\n${body}\n{% /template code %}` : body;
        assertSourceLimit(scope);
        return scope;
      },
    },
  };
}
