import { describe, expect, test } from "vite-plus/test";
import {
  evaluateDocument,
  formatDocument,
  parseDocument,
  rewriteAssets,
  writeDocument,
} from "./index.js";
import { parse, withoutPositions } from "./test-helpers.js";

const source =
  'Hello {% $student.name %}.\n\n{% if and(equals($student.role, "mentor"), $course.hasExercises) %}\n\nMentor path.\n\n{% if $course.hasQuiz %}\n\nQuiz available.\n\n{% else /%}\n\nNo quiz.\n\n{% /if %}\n\n{% else /%}\n\nStudent path.\n\n{% /if %}';

describe("conditional content", () => {
  test("parses every branch and canonical writing retains references", () => {
    const document = parse(source);
    expect(document.children).toMatchObject([
      {
        type: "paragraph",
        children: [
          { type: "text" },
          { type: "topikVariable", path: ["student", "name"] },
          { type: "text" },
        ],
      },
      {
        type: "topikConditional",
        children: [
          { type: "topikBranch", children: [{ type: "paragraph" }, { type: "topikConditional" }] },
          { type: "topikBranch", condition: null, children: [{ type: "paragraph" }] },
        ],
      },
    ]);
    const written = writeDocument(document);
    expect(withoutPositions(parse(written))).toEqual(withoutPositions(document));
    expect(writeDocument(parse(written))).toBe(written);
  });

  test("resolves two roles without mutating authored branches", () => {
    const document = parse(source);
    const snapshot = structuredClone(document);
    const mentor = evaluateDocument(document, {
      student: { name: "Ari", role: "mentor" },
      course: { hasExercises: true, hasQuiz: false },
    });
    const student = evaluateDocument(document, {
      student: { name: "Bo", role: "student" },
      course: { hasExercises: false },
    });
    const mentorSource = writeDocument(mentor);
    const studentSource = writeDocument(student);
    expect(mentorSource).toContain("Hello Ari.");
    expect(mentorSource).toContain("Mentor path.\n\nNo quiz.");
    expect(mentorSource).not.toContain("Student path.");
    expect(studentSource).toContain("Hello Bo.");
    expect(studentSource).toContain("Student path.");
    expect(studentSource).not.toContain("Mentor path.");
    expect(document).toEqual(snapshot);
    expect(writeDocument(document)).toContain("{% else /%}");
  });

  test("rewrites assets in inactive branches without selecting one", () => {
    const authored = parse(
      "{% if $flag %}\n\n![Yes](asset:old)\n\n{% else /%}\n\n![No](asset:old)\n\n{% /if %}",
    );
    const rewritten = rewriteAssets(authored, (url) =>
      url === "asset:old" ? "asset:new" : undefined,
    );
    expect(writeDocument(rewritten).match(/asset:new/g)).toHaveLength(2);
    expect(writeDocument(authored).match(/asset:old/g)).toHaveLength(2);
  });

  test.each([
    "{% if unknown($flag) %}\n\nYes.\n\n{% /if %}",
    "{% if and($flag) %}\n\nYes.\n\n{% /if %}",
    "{% if equals($flag, ) %}\n\nYes.\n\n{% /if %}",
    "{% if $flag %}\n\nYes.\n\n{% else /%}\n\n{% if unknown(true) %}\n\nNo.\n\n{% /if %}\n\n{% /if %}",
  ])("refuses malformed expressions and retains source", (invalid) => {
    expect(parseDocument(invalid)).toMatchObject({ ok: false, source: invalid });
  });

  test("format remains context-free and converges", () => {
    const first = formatDocument(source);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = formatDocument(first.formatted!);
    expect(second).toMatchObject({ ok: true, formatted: first.formatted });
  });
});
