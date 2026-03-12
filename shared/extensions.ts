/**
 * Extension discovery — scan extensions/*/manifest.json and load seed fragments.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionManifest } from "./types";

/** Resolve CLAUDE_FLEET root from this file's location (shared/ is one level below root) */
const FLEET_ROOT = dirname(__dirname);

export interface LoadedExtension {
  dir: string;
  manifest: ExtensionManifest;
}

export interface SeedFragment {
  extensionName: string;
  content: string;
}

/**
 * Discover all extensions by scanning extensions/*/manifest.json.
 * Returns manifests sorted alphabetically by name.
 */
export function loadExtensionManifests(): LoadedExtension[] {
  const extDir = join(FLEET_ROOT, "extensions");
  if (!existsSync(extDir)) return [];

  const results: LoadedExtension[] = [];
  let entries: string[];
  try {
    entries = readdirSync(extDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const manifestPath = join(extDir, entry, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as ExtensionManifest;
      results.push({ dir: join(extDir, entry), manifest });
    } catch {
      // Skip malformed manifests
    }
  }

  return results.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/**
 * Load seed fragments from all extensions that declare them.
 * Fragments are returned in alphabetical order by extension name.
 * Missing fragment files are skipped with a warning.
 */
export function loadSeedFragments(): SeedFragment[] {
  const extensions = loadExtensionManifests();
  const fragments: SeedFragment[] = [];

  for (const { dir, manifest } of extensions) {
    const paths = manifest.templates?.["seed-fragments"];
    if (!paths || paths.length === 0) continue;

    for (const relPath of paths) {
      const absPath = join(dir, relPath);
      if (!existsSync(absPath)) {
        console.warn(`[extensions] seed fragment not found: ${absPath} (extension: ${manifest.name})`);
        continue;
      }
      try {
        const content = readFileSync(absPath, "utf-8");
        fragments.push({ extensionName: manifest.name, content });
      } catch {
        console.warn(`[extensions] failed to read seed fragment: ${absPath}`);
      }
    }
  }

  return fragments;
}
