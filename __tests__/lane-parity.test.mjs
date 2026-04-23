import { describe, expect, it } from 'vitest';
import { LANES } from '@botoff/shared';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_LANES, PLUGIN_DEFAULT_LANE } from '../index.js';

/**
 * Pins the plugin's lane values. Imports PLUGIN_LANES and
 * PLUGIN_DEFAULT_LANE directly from index.js (the plugin is the source of
 * truth for its own opinionated defaults) and confirms:
 *
 *   1. PLUGIN_LANES is a subset of shared LANES — plugin values that
 *      disappear from shared fail fast, but new shared-only lanes (likely
 *      aimed at other play paths like GET-play) are allowed to exist
 *      without forcing the plugin to mirror them.
 *   2. PLUGIN_DEFAULT_LANE is one of the plugin's own lanes.
 *   3. `openclaw.plugin.json` configSchema is in sync with the in-code
 *      values (enum + default match index.js).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');

describe('plugin lane values', () => {
  it('PLUGIN_LANES is a subset of shared LANES', () => {
    for (const lane of PLUGIN_LANES) {
      expect(LANES).toContain(lane);
    }
  });

  it('PLUGIN_DEFAULT_LANE is one of PLUGIN_LANES', () => {
    expect(PLUGIN_LANES).toContain(PLUGIN_DEFAULT_LANE);
  });

  it('openclaw.plugin.json configSchema matches in-code values', async () => {
    const raw = await readFile(path.join(pluginDir, 'openclaw.plugin.json'), 'utf8');
    const json = JSON.parse(raw);
    const laneSchema = json.configSchema?.properties?.defaultLane;
    expect(laneSchema, 'defaultLane missing from openclaw.plugin.json configSchema').toBeTruthy();
    expect(laneSchema.enum).toEqual([...PLUGIN_LANES]);
    expect(laneSchema.default).toBe(PLUGIN_DEFAULT_LANE);
  });
});
