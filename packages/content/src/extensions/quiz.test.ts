import { expect, test } from "vite-plus/test";
import { getEffectiveProps, parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

function quiz(choices: string, type = ""): string {
  return `{% quiz %}\n\n{% question${type} %}\n\n${choices}\n\n{% /question %}\n\n{% /quiz %}`;
}
const correct = "{% choice correct=true %}\n\nYes.\n\n{% /choice %}";
const incorrect = "{% choice %}\n\nNo.\n\n{% /choice %}";

test("quiz preserves its question structure, typed choices, and unauthored defaults", () => {
  const document = parse(quiz(`${correct}\n\n${incorrect}`));
  expect(document.children[0]).toMatchObject({
    name: "quiz",
    children: [{ name: "question", children: [{ name: "choice" }, { name: "choice" }] }],
  });
  const outer = document.children[0];
  if (outer.type !== "topikComponent" || outer.children[0].type !== "topikComponent")
    throw new Error("Expected question");
  const question = outer.children[0];
  expect(question.props).toEqual({});
  expect(getEffectiveProps(question)).toEqual({ type: "single-choice" });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("quiz requires a direct question child", () => {
  const source = "{% quiz %}\n\n{% /quiz %}";
  const result = parseDocument(source);
  expect(result).toMatchObject({ ok: false, source });
  if (!result.ok)
    expect(result.diagnostics.map((item) => item.id)).toContain("topik-quiz-requires-question");
});

test("question enforces choice count and correct answers for both interaction types", () => {
  for (const [source, id] of [
    [quiz(correct), "topik-question-choice-count"],
    [quiz(`${incorrect}\n\n${incorrect}`), "topik-question-single-correct-choice"],
    [quiz(`${correct}\n\n${correct}`), "topik-question-single-correct-choice"],
    [
      quiz(`${incorrect}\n\n${incorrect}`, ' type="multiple-choice"'),
      "topik-question-correct-choice-required",
    ],
  ]) {
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok) expect(result.diagnostics.map((item) => item.id)).toContain(id);
  }
});

test("choice retains explicit false separately from its default", () => {
  const source =
    "{% quiz %}\n\n{% question %}\n\n{% choice correct=true %}\n\nYes.\n\n{% /choice %}\n\n{% choice correct=false %}\n\nNo.\n\n{% /choice %}\n\n{% /question %}\n\n{% /quiz %}";
  const document = parse(source);
  const quiz = document.children[0];
  if (
    quiz.type !== "topikComponent" ||
    quiz.children[0].type !== "topikComponent" ||
    quiz.children[0].children[1].type !== "topikComponent"
  )
    throw new Error("Expected choice");
  const choice = quiz.children[0].children[1];
  expect(choice.props).toEqual({ correct: false });
  expect(getEffectiveProps(choice)).toEqual({ correct: false });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("choice requires question parent and boolean correct value", () => {
  for (const [source, id] of [
    ["{% choice %}\n\nLoose.\n\n{% /choice %}", "topik-question-parent-required"],
    ['{% choice correct="true" %}\n\nWrong type.\n\n{% /choice %}', "attribute-type-invalid"],
  ]) {
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok) expect(result.diagnostics.map((item) => item.id)).toContain(id);
  }
});

test("explanation keeps block content after quiz choices", () => {
  const source =
    "{% quiz %}\n\n{% question %}\n\n{% choice correct=true %}\n\nA.\n\n{% /choice %}\n\n{% choice %}\n\nB.\n\n{% /choice %}\n\n{% explanation %}\n\nBecause **A**.\n\n{% /explanation %}\n\n{% /question %}\n\n{% /quiz %}";
  const document = parse(source);
  expect(document.children[0]).toMatchObject({
    children: [
      {
        children: [
          { name: "choice" },
          { name: "choice" },
          { name: "explanation", children: [{ type: "paragraph" }] },
        ],
      },
    ],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("explanation outside question is refused", () => {
  const source = "{% explanation %}\n\nLoose.\n\n{% /explanation %}";
  const result = parseDocument(source);
  expect(result).toMatchObject({ ok: false, source });
  if (!result.ok)
    expect(result.diagnostics.map((item) => item.id)).toContain("topik-question-parent-required");
});
