import type { Node, Schema, ValidationError } from "@markdoc/markdoc";
import { QUIZ_QUESTION_TYPES } from "../components";
import {
  FLOW_CHILDREN,
  composeValidators,
  directTagChildren,
  error,
  validateOnlyDirectTagChildren,
  validateParentTag,
  validateRequiredDirectTagChild,
} from "./helpers";

export const quizTag: Schema = {
  render: "TopikQuiz",
  children: ["tag"],
  validate: composeValidators(
    validateOnlyDirectTagChildren("quiz", ["question"]),
    validateRequiredDirectTagChild("quiz", "question"),
  ),
};

export const questionTag: Schema = {
  render: "TopikQuestion",
  children: ["paragraph", "tag"],
  attributes: {
    type: { type: String, matches: [...QUIZ_QUESTION_TYPES], default: "single-choice" },
  },
  validate: composeValidators(
    validateParentTag("quiz"),
    validateOnlyDirectTagChildren("question", ["choice", "explanation"]),
    validateQuestionChoiceCount,
    validateQuestionCorrectChoices,
  ),
};

export const choiceTag: Schema = {
  render: "TopikChoice",
  children: [...FLOW_CHILDREN],
  attributes: {
    correct: { type: Boolean, default: false },
  },
  validate: validateParentTag("question"),
};

export const explanationTag: Schema = {
  render: "TopikExplanation",
  children: [...FLOW_CHILDREN],
  validate: validateParentTag("question"),
};

function validateQuestionChoiceCount(node: Node): ValidationError[] {
  const choices = directTagChildren(node, "choice");
  if (choices.length >= 2) return [];
  return [
    error("topik-question-choice-count", "'question' requires at least two 'choice' children."),
  ];
}

function validateQuestionCorrectChoices(node: Node): ValidationError[] {
  const choices = directTagChildren(node, "choice");
  const correctCount = choices.filter((choice) => choice.attributes.correct === true).length;
  const type = node.attributes.type ?? "single-choice";

  if (type === "single-choice" && correctCount === 1) return [];
  if (type === "multiple-choice" && correctCount > 0) return [];

  if (type === "multiple-choice") {
    return [
      error(
        "topik-question-correct-choice-required",
        "'multiple-choice' questions require at least one correct choice.",
      ),
    ];
  }

  return [
    error(
      "topik-question-single-correct-choice",
      "'single-choice' questions require exactly one correct choice.",
    ),
  ];
}
