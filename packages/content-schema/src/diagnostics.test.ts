import { describe, expect, test } from "vite-plus/test";
import { sanitizeTopikDiagnosticFile } from "./diagnostics";

const privateLabelPattern =
  /SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u;

describe("diagnostic file sanitization", () => {
  test.each([
    " https://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
    "\thttps://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
    "https%3A%2F%2Fuser%3AFILE_CREDENTIAL_SENTINEL%40example.com%2FSENSITIVE_DIRECTORY%2Flesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL",
    "https%253A%252F%252Fuser%253AFILE_CREDENTIAL_SENTINEL%2540example.com%252FSENSITIVE_DIRECTORY%252Flesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL",
    "/tmp/SENSITIVE_DIRECTORY%2Flesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL",
    String.raw`C:\SENSITIVE_DIRECTORY%5Clesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL`,
    String.raw`\\server\SENSITIVE_DIRECTORY%5Clesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL`,
    String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL`,
    String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL`,
    "https://example.com/SENSITIVE_DIRECTORY%2Flesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
    "https://user:%46ILE_CREDENTIAL_SENTINEL@example.com/lesson.md",
    "https ://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
    "https&colon;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
    "https&amp;colon;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
    "https&#58;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
    "https&#x3a;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
    "https&amp;#58;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
    "\u0085/tmp/SENSITIVE_DIRECTORY/lesson.md",
    "\u200B/tmp/SENSITIVE_DIRECTORY/lesson.md",
    "\u2028/tmp/SENSITIVE_DIRECTORY/lesson.md",
    "\u202E/tmp/SENSITIVE_DIRECTORY/lesson.md",
  ])("fails an encoded or whitespace-ambiguous label closed: %s", (file) => {
    const label = sanitizeTopikDiagnosticFile(file);

    expect(label).toBe("content");
    expect(label).not.toMatch(privateLabelPattern);
  });

  test.each([
    String.raw`C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    String.raw`\\user:FILE_CREDENTIAL_SENTINEL@server\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    String.raw`\\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    String.raw`\Device\HarddiskVolume1\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    "https://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
    "file:///SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
  ])("removes private suffixes from a rooted file label", (file) => {
    const label = sanitizeTopikDiagnosticFile(file);

    expect(label).toBe("lesson.md");
    expect(label).not.toMatch(privateLabelPattern);
  });

  test.each([
    String.raw`C:\SENSITIVE_DIRECTORY\?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    String.raw`\\server\SENSITIVE_DIRECTORY\#FRAGMENT_SENTINEL`,
    "https://user:FILE_CREDENTIAL_SENTINEL@[?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
    "https://user:%46ILE_CREDENTIAL_SENTINEL@[?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL",
  ])("fails a malformed private file label closed: %s", (file) => {
    const label = sanitizeTopikDiagnosticFile(file);

    expect(label).toBe("content");
    expect(label).not.toMatch(privateLabelPattern);
  });

  test.each(["lesson.md", "guides/lesson.md", String.raw`guides\lesson.md`])(
    "preserves safe relative file label %s",
    (file) => {
      expect(sanitizeTopikDiagnosticFile(file)).toBe(file);
    },
  );
});
