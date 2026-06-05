import type { Config } from "@markdoc/markdoc";
import { calloutTag } from "./tags/callout";
import { cardGridTag, cardTag } from "./tags/cards";
import { accordionTag } from "./tags/disclosure";
import { badgeTag } from "./tags/inline";
import { figureTag } from "./tags/media";
import { choiceTag, explanationTag, questionTag, quizTag } from "./tags/quiz";
import { stepTag, stepsTag } from "./tags/steps";
import { tabTag, tabsTag } from "./tags/tabs";

export const topikMarkdocConfig = {
  tags: {
    accordion: accordionTag,
    badge: badgeTag,
    callout: calloutTag,
    card: cardTag,
    cardGrid: cardGridTag,
    choice: choiceTag,
    explanation: explanationTag,
    figure: figureTag,
    question: questionTag,
    quiz: quizTag,
    step: stepTag,
    steps: stepsTag,
    tab: tabTag,
    tabs: tabsTag,
  },
  validation: {
    validateFunctions: true,
  },
} as const satisfies Config;
