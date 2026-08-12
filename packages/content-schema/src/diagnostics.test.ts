import { describe, expect, test } from "vite-plus/test";
import { sanitizeTopikDiagnosticFile } from "./diagnostics";

const privateLabelPattern =
  /SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u;

describe("diagnostic file sanitization", () => {
  test.each([
    String.raw`C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL`,
    String.raw`\\user:FILE_CREDENTIAL_SENTINEL@server\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    String.raw`\\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL`,
    String.raw`\Device\HarddiskVolume1\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
    "https://user:%46ILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL",
    "file:///SENSITIVE_DIRECTORY/lesson.md?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL",
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
  ])("fails a malformed private file label closed", (file) => {
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
