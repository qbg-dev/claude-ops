import { defineCommand } from "citty";
import { defaultsPath } from "../lib/paths";
import { getDefaults, writeJson } from "../lib/config";
import { ok } from "../lib/fmt";

export default defineCommand({
  meta: { name: "defaults", description: "Get/set global defaults" },
  args: {
    key: { type: "positional", description: "Key to get/set", required: false },
    value: { type: "positional", description: "New value", required: false },
  },
  run({ args }) {
    const defaults = getDefaults();

    if (!args.key) {
      console.log(JSON.stringify(defaults, null, 2));
      return;
    }

    if (!args.value) {
      const val = defaults[args.key];
      console.log(typeof val === "object" ? JSON.stringify(val, null, 2) : String(val ?? "null"));
      return;
    }

    // Set
    let parsed: unknown = args.value;
    if (args.value === "null") parsed = null;
    else if (args.value === "true") parsed = true;
    else if (args.value === "false") parsed = false;
    else if (/^\d+$/.test(args.value)) parsed = parseInt(args.value, 10);

    defaults[args.key] = parsed;
    writeJson(defaultsPath(), defaults);
    ok(`${args.key} → ${args.value}`);
  },
});
