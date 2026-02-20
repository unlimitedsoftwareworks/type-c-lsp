# Type-C Compiler

## Compile CLI

Run the compiler with:

```bash
node packages/compiler/bin/cli.js compile <workspace-folder>
```

Example:

```bash
node packages/compiler/bin/cli.js compile packages/language/test/test-cases/runtime-tests/
```

## Output Artifacts

For an output path like `.../output.tvbc`, the compiler now emits:

- `output.tvbc` - VM bytecode
- `output.ir` - full textual IR (same directory, same basename)

This makes debugging easier because IR can be grepped without relying on large console dumps.

## Debug / Build Flags

- `TYPEC_VERBOSE_IR=1`  
  Enables verbose IR logging from the IR generator (class/method/function IR in stdout).

- `TYPEC_SKIP_AUTOBUILD=1`  
  Disables the CLI auto-build freshness check. By default, the CLI rebuilds `packages/compiler`
  when `src/**/*.ts` is newer than compiled output.
