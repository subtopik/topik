import type { Config } from "@markdoc/markdoc";
import { calloutTag } from "./tags/callout";
import { cardGridTag, cardTag } from "./tags/cards";
import { codeGroupTag, codeTabTag } from "./tags/code";
import { accordionTag } from "./tags/disclosure";
import { badgeTag, underlineTag } from "./tags/inline";
import { mathInlineTag, mathTag } from "./tags/math";
import { figureTag } from "./tags/media";
import { choiceTag, explanationTag, questionTag, quizTag } from "./tags/quiz";
import { stepTag, stepsTag } from "./tags/steps";
import { tabTag, tabsTag } from "./tags/tabs";
import { topikNodeSchemas } from "./nodes";

export const topikMarkdocConfig = {
  nodes: topikNodeSchemas,
  tags: {
    accordion: accordionTag,
    badge: badgeTag,
    callout: calloutTag,
    card: cardTag,
    cardGrid: cardGridTag,
    codeGroup: codeGroupTag,
    codeTab: codeTabTag,
    choice: choiceTag,
    explanation: explanationTag,
    figure: figureTag,
    math: mathTag,
    mathInline: mathInlineTag,
    question: questionTag,
    quiz: quizTag,
    step: stepTag,
    steps: stepsTag,
    tab: tabTag,
    tabs: tabsTag,
    u: underlineTag,
    underline: underlineTag,
  },
  validation: {
    validateFunctions: true,
  },
} as const satisfies Config;

/**
 * Extend Topik's Markdoc environment without replacing canonical node or tag schemas.
 * Canonical validation always wins on normal source APIs.
 */
export function mergeTopikMarkdocConfig(extension: Config = {}): Config {
  const canonical: Config = topikMarkdocConfig;
  return {
    ...extension,
    ...canonical,
    nodes: { ...extension.nodes, ...canonical.nodes },
    tags: { ...extension.tags, ...canonical.tags },
    variables: { ...extension.variables, ...canonical.variables },
    functions: { ...extension.functions, ...canonical.functions },
    partials: { ...extension.partials, ...canonical.partials },
    validation: { ...extension.validation, ...canonical.validation },
  };
}
