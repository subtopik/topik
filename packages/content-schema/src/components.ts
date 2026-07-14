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

export const CALLOUT_VARIANTS = ["info", "tip", "warning", "danger"] as const;
export const BADGE_VARIANTS = ["neutral", "info", "success", "warning", "danger"] as const;
export const QUIZ_QUESTION_TYPES = ["single-choice", "multiple-choice"] as const;

export const topikComponents = {
  codeBlock: {
    name: "codeBlock",
    render: "TopikCodeBlock",
    kind: "block",
    description: "A fenced code block with an optional language.",
    attributes: {
      language: { type: "string", description: "Code language identifier." },
    },
  },
  inlineCode: {
    name: "inlineCode",
    render: "TopikInlineCode",
    kind: "inline",
    description: "Inline code text.",
  },
  underline: {
    name: "underline",
    render: "TopikUnderline",
    kind: "inline",
    description: "Inline underlined text.",
  },
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
  codeGroup: {
    name: "codeGroup",
    render: "TopikCodeGroup",
    kind: "block",
    description: "A set of labeled code tabs.",
    allowedChildren: ["codeTab"],
    requiredChildren: ["codeTab"],
  },
  codeTab: {
    name: "codeTab",
    render: "TopikCodeTab",
    kind: "block",
    description: "A labeled code example inside a code group.",
    attributes: {
      title: { type: "string", required: true, description: "Visible code tab label." },
      icon: { type: "string", description: "Optional icon identifier." },
    },
    allowedChildren: ["fence"],
    requiredChildren: ["fence"],
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
  image: {
    name: "image",
    render: "TopikImage",
    kind: "block",
    description: "Markdown image rendered through Topik asset resolution.",
    attributes: {
      src: { type: "string", required: true, description: "Image source URL." },
      alt: { type: "string", description: "Accessible alternative text." },
      title: { type: "string", description: "Optional image title." },
    },
  },
  link: {
    name: "link",
    render: "TopikLink",
    kind: "inline",
    description: "Markdown link with optional application-level navigation interception.",
    attributes: {
      href: { type: "string", required: true, description: "Link target URL." },
      title: { type: "string", description: "Optional link title." },
    },
  },
  math: {
    name: "math",
    render: "TopikMath",
    kind: "block",
    description: "Block math expression.",
    attributes: {
      content: { type: "string", required: true, description: "Math source." },
    },
  },
  mathInline: {
    name: "mathInline",
    render: "TopikMathInline",
    kind: "inline",
    description: "Inline math expression.",
    attributes: {
      content: { type: "string", required: true, description: "Math source." },
    },
  },
  mermaid: {
    name: "mermaid",
    render: "TopikMermaid",
    kind: "block",
    description: "Mermaid diagram rendered from a fenced mermaid code block.",
    attributes: {
      content: { type: "string", required: true, description: "Mermaid diagram source." },
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
  table: {
    name: "table",
    render: "TopikTable",
    kind: "block",
    description: "Markdown table.",
  },
  tableRow: {
    name: "tableRow",
    render: "TopikTableRow",
    kind: "block",
    description: "A row inside a Markdown table.",
  },
  tableCell: {
    name: "tableCell",
    render: "TopikTableCell",
    kind: "block",
    description: "A cell inside a Markdown table.",
  },
  tableHeader: {
    name: "tableHeader",
    render: "TopikTableHeader",
    kind: "block",
    description: "A header cell inside a Markdown table.",
  },
} as const satisfies Record<string, TopikComponentDefinition>;

export type TopikComponentName = keyof typeof topikComponents;
