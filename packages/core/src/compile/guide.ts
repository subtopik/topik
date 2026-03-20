import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Guide } from "@topik/schema";
import type { Resource } from "../resource";
import { parseCollectionConfig } from "../config/collection";
import { parse as parseYaml } from "yaml";
import { readConfigFile } from "./config";

export interface CompileGuidesOptions {
  dir: string;
}

export interface CompileResult {
  resources: Resource[];
}

export async function compileGuides(options: CompileGuidesOptions): Promise<CompileResult> {
  const dir = resolve(options.dir);

  const raw = await readConfigFile(dir, ["collection.yaml", "collection.yml", "collection.json"]);
  const config = parseCollectionConfig(raw);

  const files = await readdir(dir);
  const markdownFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx")).sort();

  const resources: Resource[] = [];

  for (const file of markdownFiles) {
    const filePath = join(dir, file);
    const rawContent = await readFile(filePath, "utf-8");
    const { frontmatter, content } = parseFrontmatter(rawContent, file);

    const slug = fileToSlug(file);
    const name = `${config.id}-${slug}`;
    const title =
      typeof frontmatter.title === "string" ? frontmatter.title : extractTitle(content, slug);

    const tags = mergeTags(config.tags, frontmatter.tags);

    const authors = Array.isArray(frontmatter.authors)
      ? (frontmatter.authors as string[])
      : undefined;
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description : undefined;

    const guide: Guide = {
      apiVersion: "v1",
      type: "Guide",
      name,
      spec: {
        title,
        slug,
        ...(description != null ? { description } : {}),
        ...(authors != null ? { authors } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        content: {
          format: "topik",
          value: content,
        },
      },
    };

    resources.push(guide);
  }

  return { resources };
}

function parseFrontmatter(
  raw: string,
  filePath: string,
): { frontmatter: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match) {
    try {
      const frontmatter = parseYaml(match[1]);
      if (frontmatter == null) {
        return { frontmatter: {}, content: match[2] };
      }
      if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
        throw new Error("Frontmatter must parse to an object");
      }
      if (
        "title" in frontmatter &&
        frontmatter.title != null &&
        typeof frontmatter.title !== "string"
      ) {
        throw new Error("Frontmatter title must be a string");
      }
      return { frontmatter, content: match[2] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid frontmatter in ${filePath}: ${message}`, { cause: error });
    }
  }
  return { frontmatter: {}, content: raw };
}

function fileToSlug(filename: string): string {
  return filename.replace(/\.(mdx?|md)$/, "");
}

export function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }
  return fallback
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function mergeTags(collectionTags: string[] | undefined, frontmatterTags: unknown): string[] {
  const tags = new Set<string>();
  if (collectionTags) {
    for (const tag of collectionTags) {
      tags.add(tag);
    }
  }
  if (Array.isArray(frontmatterTags)) {
    for (const tag of frontmatterTags) {
      if (typeof tag === "string") {
        tags.add(tag);
      }
    }
  }
  return [...tags];
}
