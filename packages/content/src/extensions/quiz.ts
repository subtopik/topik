import type { AuthoredAttributeValue, Component } from "../model.js";
import type { ComponentDefinition, ValidationIssue } from "../registry.js";

export const quizDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikQuiz",
  description: "Self-check quiz made of question components.",
  attributes: {},
  children: { components: ["question"], min: 1 },
};

function validateQuestion(
  component: Component,
  props: Record<string, AuthoredAttributeValue>,
): ValidationIssue[] {
  const choices = component.children.filter(
    (child): child is Component => child.type === "topikComponent" && child.name === "choice",
  );
  const issues: ValidationIssue[] = [];
  if (choices.length < 2)
    issues.push({
      id: "topik-question-choice-count",
      message: "question requires at least two choice children",
    });
  const correct = choices.filter((choice) => choice.props.correct === true).length;
  if (props.type === "multiple-choice" && correct === 0)
    issues.push({
      id: "topik-question-correct-choice-required",
      message: "multiple-choice questions require at least one correct choice",
    });
  else if (props.type !== "multiple-choice" && correct !== 1)
    issues.push({
      id: "topik-question-single-correct-choice",
      message: "single-choice questions require exactly one correct choice",
    });
  return issues;
}

export const questionDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikQuestion",
  description: "Quiz question containing at least two choices.",
  attributes: {
    type: {
      type: "enum",
      values: ["single-choice", "multiple-choice"],
      default: "single-choice",
      description: "Question interaction model.",
    },
  },
  children: { components: ["choice", "explanation"] },
  allowedParents: ["quiz"],
  validate: validateQuestion,
};

export const choiceDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikChoice",
  description: "Answer choice inside a quiz question.",
  attributes: {
    correct: { type: "boolean", default: false, description: "Whether this choice is correct." },
  },
  children: "blocks",
  allowedParents: ["question"],
};

export const explanationDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikExplanation",
  description: "Explanation shown after answering a quiz question.",
  attributes: {},
  children: "blocks",
  allowedParents: ["question"],
};
