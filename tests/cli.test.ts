import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { positionalArgs } from "../src/cli-args.js";

describe("CLI argument parsing", () => {
  it("does not treat a provider flag value as a demo scenario", () => {
    expect(positionalArgs(["--provider", "offline"], ["--provider"])).toEqual([]);
    expect(
      positionalArgs(["dns-outage", "--provider", "offline"], ["--provider"]),
    ).toEqual(["dns-outage"]);
  });
});

describe("CLI package entry", () => {
  it("points at the path produced by the TypeScript build", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { bin: { ait: string } };

    expect(packageJson.bin.ait).toBe("./dist/src/cli.js");
  });
});
