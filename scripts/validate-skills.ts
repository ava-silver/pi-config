#!/usr/bin/env bun
// Validates the front matter every Agent skill needs.
import { basename, dirname } from "node:path";

const extractFrontMatter = (document: string): string | Error => {
  if (!document.startsWith("---\n"))
    return new Error("must start with YAML front matter");
  const end = document.indexOf("\n---\n", 4);
  return end === -1
    ? new Error("front matter must end with '---'")
    : document.slice(4, end);
};

const nonEmptyString = (value: unknown): boolean =>
  typeof value === "string" && value.trim() !== "";

const validateMetadata = (metadata: unknown, dirName: string): string[] => {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return ["front matter must be a mapping"];
  }
  const fields = metadata as Record<string, unknown>;
  return [
    ...["name", "description"]
      .filter((key) => !nonEmptyString(fields[key]))
      .map((key) => `'${key}' must be a non-empty string`),
    ...(fields.name === dirName
      ? []
      : [`'name' must match directory '${dirName}'`]),
  ];
};

const validate = async (path: string): Promise<string[]> => {
  const frontMatter = extractFrontMatter(await Bun.file(path).text());
  if (frontMatter instanceof Error) return [frontMatter.message];
  try {
    return validateMetadata(
      Bun.YAML.parse(frontMatter),
      basename(dirname(path)),
    );
  } catch (error) {
    return [
      `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
};

const results = await Promise.all(
  Bun.argv
    .slice(2)
    .map(async (path) => ({
      path,
      errors: await validate(path).catch((e: Error) => [e.message]),
    })),
);
results.forEach(({ path, errors }) =>
  errors.forEach((error) => console.error(`${path}: ${error}`)),
);
process.exit(results.some(({ errors }) => errors.length > 0) ? 1 : 0);
