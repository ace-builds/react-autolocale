import fs from "node:fs";
import path from "node:path";
import { Args, Command, Flags, loadHelpClass } from "@oclif/core";
import { info, intro, note, ok, outro, plural, type Out } from "./out.js";
import { createTerminalOut } from "./terminal.js";

// The oclif commands (`explicit` discovery: package.json points oclif at the COMMANDS export of this file).
// Heavy modules (Babel, Vite, jsdom) are imported inside `run`, so `--help` stays instant.

const PROVIDERS = ["openai", "anthropic", "gemini", "local", "ollama"] as const;

/** The project the user means: --root, else the nearest folder (from cwd up) with a package.json. */
function findRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const langFlag = Flags.string({
  summary: "Only these target languages (comma-separated). Default: every target in the config.",
  multiple: true,
  delimiter: ",",
  helpValue: "fr,es",
});

const failed = (r: { stopped?: string; langs: Record<string, { failed: unknown[] }> } | null) =>
  !!r && (!!r.stopped || Object.values(r.langs).some((l) => l.failed.length > 0));

abstract class Base extends Command {
  static baseFlags = {
    root: Flags.directory({ summary: "Project root. Default: the nearest folder with a package.json.", exists: true, helpGroup: "GLOBAL", helpValue: "dir" }),
  };

  protected ui: Out = createTerminalOut();

  protected async project(root: string) {
    const { loadProject } = await import("../core/project.js");
    return loadProject(root, this.ui);
  }
}

class Init extends Base {
  static summary = "Set up auto-locale.config.ts, the translation engine and the Vite plugin.";
  static description =
    "Asks for the source and target languages and the translation engine (flags skip the questions), saves a pasted API key " +
    "to .env, adds .gitignore lines and adds the plugin to vite.config. Downloads nothing and translates nothing.";
  static examples = [
    "<%= config.bin %> <%= command.id %>",
    { description: "Without questions (CI, scripts):", command: "<%= config.bin %> <%= command.id %> --source en --locales fr,es,de --provider openai --yes" },
  ];
  static flags = {
    source: Flags.string({ summary: "Language your code is written in.", helpValue: "en" }),
    locales: Flags.string({ summary: "Target languages (comma-separated).", multiple: true, delimiter: ",", helpValue: "fr,es" }),
    provider: Flags.string({ summary: "Translation engine.", options: [...PROVIDERS] }),
    model: Flags.string({ summary: "Model id (required for ollama; cloud engines have a default)." }),
    "api-key-env": Flags.string({ summary: "Environment variable that holds the API key.", helpValue: "NAME" }),
    output: Flags.string({ summary: "Catalog folder, relative to the project root.", helpValue: "dir" }),
    yes: Flags.boolean({ char: "y", summary: "Ask nothing: use the flags and the detected defaults." }),
    force: Flags.boolean({ summary: "Replace an existing auto-locale.config.ts without asking." }),
  };

  async run() {
    const { flags } = await this.parse(Init);
    const [{ runInit }, { createPrompter }] = await Promise.all([import("./init.js"), import("./prompt.js")]);
    await runInit(
      findRoot(flags.root),
      {
        source: flags.source,
        locales: flags.locales?.map((l) => l.trim().toLowerCase()).filter(Boolean),
        provider: flags.provider as (typeof PROVIDERS)[number] | undefined,
        model: flags.model,
        apiKeyEnv: flags["api-key-env"],
        output: flags.output,
        force: flags.force,
      },
      createPrompter(!!process.stdin.isTTY && !flags.yes),
      this.ui,
    );
  }
}

class Generate extends Base {
  static summary = "Scan the source, then translate new strings and write the catalogs (alias: sync).";
  static description = "Incremental: existing translations are kept and only missing strings are sent to the engine. Run it after changing text in your components.";
  static aliases = ["sync"];
  static examples = ["<%= config.bin %> <%= command.id %>", "<%= config.bin %> <%= command.id %> --lang fr,es"];
  static flags = { lang: langFlag };

  async run() {
    const { flags } = await this.parse(Generate);
    const { runGenerate } = await import("./commands.js");
    const { translate } = await runGenerate(await this.project(findRoot(flags.root)), { langs: flags.lang }, this.ui);
    if (failed(translate)) process.exitCode = 1;
  }
}

class Scan extends Base {
  static summary = "Extract strings into .auto-locale/manifest.json. No translation, no network.";
  static examples = ["<%= config.bin %> <%= command.id %>"];

  async run() {
    const { flags } = await this.parse(Scan);
    const { runScan } = await import("./commands.js");
    intro(this.ui, "React Auto Locale");
    runScan(await this.project(findRoot(flags.root)), this.ui);
    outro(this.ui, "No source files modified.");
  }
}

class Translate extends Base {
  static summary = "Translate strings missing from the catalogs.";
  static description = "Also retries anything that failed before. Press Ctrl+C once to stop after the current batch; everything finished is saved.";
  static examples = ["<%= config.bin %> <%= command.id %>", "<%= config.bin %> <%= command.id %> --lang ja"];
  static flags = { lang: langFlag };

  async run() {
    const { flags } = await this.parse(Translate);
    const { runTranslate } = await import("./commands.js");
    intro(this.ui, "React Auto Locale");
    const report = await runTranslate(await this.project(findRoot(flags.root)), { langs: flags.lang }, this.ui);
    if (failed(report)) process.exitCode = 1;
    outro(this.ui, failed(report) ? "Finished with errors." : "Done.");
  }
}

class Clean extends Base {
  static summary = "Remove translations of strings that are no longer in the source.";
  static description = "Lists them first and asks before removing anything.";
  static examples = ["<%= config.bin %> <%= command.id %>", "<%= config.bin %> <%= command.id %> --yes"];
  static flags = { yes: Flags.boolean({ char: "y", summary: "Remove without asking." }) };

  async run() {
    const { flags } = await this.parse(Clean);
    const [{ runClean }, { createPrompter }] = await Promise.all([import("./commands.js"), import("./prompt.js")]);
    intro(this.ui, "React Auto Locale");
    const removed = await runClean(await this.project(findRoot(flags.root)), { yes: flags.yes }, createPrompter(!!process.stdin.isTTY && !flags.yes), this.ui);
    outro(this.ui, removed ? `Removed ${plural(removed, "string")}.` : "Nothing changed.");
  }
}

class Export extends Base {
  static summary = "Copy the generated translations to react-autolocale.overrides.json so you can edit them.";
  static description = "Anything in that file always wins over machine translation. Commit it and rebuild.";
  static examples = ["<%= config.bin %> <%= command.id %>"];

  async run() {
    const { flags } = await this.parse(Export);
    const root = findRoot(flags.root);
    const { exportTranslations } = await import("../core/overrides.js");
    intro(this.ui, "React Auto Locale");
    const { file, languages } = exportTranslations(await this.project(root));
    ok(this.ui, `Wrote ${path.relative(root, file)}: ${Object.entries(languages).map(([l, n]) => `${l} ${n}`).join(", ")} strings`);
    info(this.ui, "Edit any value, commit the file, and rebuild. Your edits always win over machine translation.");
    outro(this.ui, "Done.");
  }
}

class Add extends Base {
  static summary = "Copy an editable <LanguageSwitcher /> or <LanguageBanner /> into your project.";
  static examples = ["<%= config.bin %> <%= command.id %> switcher", "<%= config.bin %> <%= command.id %> banner --dir src/ui"];
  static args = { component: Args.string({ description: "Component to add.", required: true, options: ["switcher", "banner"] }) };
  static flags = { dir: Flags.string({ summary: "Folder to write it to. Default: src/components (or components/).", helpValue: "dir" }) };

  async run() {
    const { args, flags } = await this.parse(Add);
    const { addComponent } = await import("./add.js");
    const { file, name } = addComponent(findRoot(flags.root), args.component as "switcher" | "banner", flags.dir);
    ok(this.ui, `Created ${file}`);
    note(this.ui, `import { ${name} } from "./components/${name}";`, "Import it anywhere");
  }
}

/** `react-autolocale help [command]`: oclif core only handles `--help`; the help command normally comes from a plugin. */
class HelpCommand extends Command {
  static summary = "Show help for react-autolocale or one of its commands.";
  static strict = false;
  static args = { command: Args.string({ description: "Command to show help for." }) };

  async run() {
    const { argv } = await this.parse(HelpCommand);
    const Help = await loadHelpClass(this.config);
    await new Help(this.config, this.config.pjson.oclif.helpOptions).showHelp(argv as string[]);
  }
}

export const COMMANDS = { init: Init, generate: Generate, scan: Scan, translate: Translate, clean: Clean, export: Export, add: Add, help: HelpCommand };
