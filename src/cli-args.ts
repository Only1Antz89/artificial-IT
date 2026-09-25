/**
 * Return command-line positionals without mistaking flag values for them.
 *
 * The CLI keeps flag parsing deliberately small, but a value such as
 * `offline` in `demo --provider offline` is not a scenario name.
 */
export function positionalArgs(
  args: string[],
  flagsWithValues: readonly string[] = [],
): string[] {
  const valued = new Set(flagsWithValues);
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valued.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) positionals.push(arg);
  }

  return positionals;
}
