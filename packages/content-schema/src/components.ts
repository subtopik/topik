export const TOPIK_CONTENT_SCHEMA_VERSION = "0.1.0";

export type TopikComponentKind = "block" | "inline";
export type TopikAttributeType = "string" | "number" | "boolean" | "enum";

export interface TopikComponentAttributeDefinition {
  type: TopikAttributeType;
  required?: boolean;
  values?: readonly string[];
  min?: number;
  max?: number;
  description?: string;
}

export interface TopikComponentDefinition {
  name: string;
  render: string;
  kind: TopikComponentKind;
  description: string;
  attributes?: Record<string, TopikComponentAttributeDefinition>;
  allowedChildren?: readonly string[];
  requiredChildren?: readonly string[];
}

export const CALLOUT_VARIANTS = ["note", "tip", "warning", "danger", "info"] as const;
export const BADGE_VARIANTS = ["neutral", "info", "success", "warning", "danger"] as const;
export const QUIZ_QUESTION_TYPES = ["single-choice", "multiple-choice"] as const;

export const topikComponents = {
  callout: {
    name: "callout",
    render: "TopikCallout",
    kind: "block",
    description: "Highlighted contextual content such as a note, tip, warning, or danger message.",
    attributes: {
      variant: {
        type: "enum",
        values: CALLOUT_VARIANTS,
        description: "Visual and semantic callout variant.",
      },
      title: { type: "string", description: "Optional callout heading." },
    },
  },
  cardGrid: {
    name: "cardGrid",
    render: "TopikCardGrid",
    kind: "block",
    description: "Responsive grid of card links or summary cards.",
    attributes: {
      columns: {
        type: "number",
        min: 1,
        max: 4,
        description: "Preferred number of columns, from 1 to 4.",
      },
    },
    allowedChildren: ["card"],
  },
  card: {
    name: "card",
    render: "TopikCard",
    kind: "block",
    description: "A card within a card grid.",
    attributes: {
      title: { type: "string", required: true, description: "Card title." },
      href: { type: "string", description: "Optional target URL." },
      icon: { type: "string", description: "Optional icon identifier." },
    },
  },
  accordion: {
    name: "accordion",
    render: "TopikAccordion",
    kind: "block",
    description: "A single disclosure section with a required title.",
    attributes: {
      title: { type: "string", required: true, description: "Accordion title." },
      open: { type: "boolean", description: "Whether the accordion is expanded by default." },
    },
  },
  tabs: {
    name: "tabs",
    render: "TopikTabs",
    kind: "block",
    description: "A tab set containing one or more tab panels.",
    allowedChildren: ["tab"],
    requiredChildren: ["tab"],
  },
  tab: {
    name: "tab",
    render: "TopikTab",
    kind: "block",
    description: "A tab panel inside a tabs component.",
    attributes: {
      title: { type: "string", required: true, description: "Visible tab label." },
    },
  },
  steps: {
    name: "steps",
    render: "TopikSteps",
    kind: "block",
    description: "Ordered instructional steps.",
    allowedChildren: ["step"],
    requiredChildren: ["step"],
  },
  step: {
    name: "step",
    render: "TopikStep",
    kind: "block",
    description: "One step inside a steps component.",
    attributes: {
      title: { type: "string", description: "Optional step heading." },
    },
  },
  figure: {
    name: "figure",
    render: "TopikFigure",
    kind: "block",
    description: "Media with an optional caption.",
    attributes: {
      src: { type: "string", required: true, description: "Default/light image source URL." },
      darkSrc: { type: "string", description: "Optional dark-mode image source URL." },
      alt: { type: "string", required: true, description: "Accessible alternative text." },
      caption: { type: "string", description: "Optional figure caption." },
    },
  },
  badge: {
    name: "badge",
    render: "TopikBadge",
    kind: "inline",
    description: "Small inline status or metadata label.",
    attributes: {
      variant: {
        type: "enum",
        values: BADGE_VARIANTS,
        description: "Badge color/semantic variant.",
      },
    },
  },
  quiz: {
    name: "quiz",
    render: "TopikQuiz",
    kind: "block",
    description: "Self-check quiz made of question components.",
    allowedChildren: ["question"],
    requiredChildren: ["question"],
  },
  question: {
    name: "question",
    render: "TopikQuestion",
    kind: "block",
    description: "Quiz question containing at least two choices.",
    attributes: {
      type: {
        type: "enum",
        values: QUIZ_QUESTION_TYPES,
        description: "Question interaction model.",
      },
    },
    allowedChildren: ["choice", "explanation"],
    requiredChildren: ["choice"],
  },
  choice: {
    name: "choice",
    render: "TopikChoice",
    kind: "block",
    description: "Answer choice inside a quiz question.",
    attributes: {
      correct: { type: "boolean", description: "Whether this choice is correct." },
    },
  },
  explanation: {
    name: "explanation",
    render: "TopikExplanation",
    kind: "block",
    description: "Explanation shown after answering a quiz question.",
  },
} as const satisfies Record<string, TopikComponentDefinition>;

export type TopikComponentName = keyof typeof topikComponents;
