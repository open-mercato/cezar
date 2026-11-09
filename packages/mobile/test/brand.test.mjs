import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodePng, readMark } from '../scripts/build-brand.mjs';

const script = fileURLToPath(new URL('../scripts/build-brand.mjs', import.meta.url));
const read = (path) => readFileSync(new URL(path, import.meta.url));

test('the icons, splashes and connect mark match docs/brand', () => {
  execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' });
});

test('the brand source is four polygons centred in the tile', () => {
  const mark = readMark();
  assert.equal(mark.polygons.length, 4);
  assert.equal(mark.cx, mark.tile / 2);
  assert.equal(mark.cy, mark.tile / 2);
});

test('the iOS app icon and tinted icon are opaque, as App Store Connect requires', () => {
  for (const file of ['AppIcon-512@2x.png', 'AppIcon-tinted-512@2x.png']) {
    const png = decodePng(read(`../ios/App/App/Assets.xcassets/AppIcon.appiconset/${file}`));
    assert.deepEqual([png.w, png.h, png.colorType], [1024, 1024, 2], file);
  }
});

test('the adaptive icon has a monochrome layer for themed icons', () => {
  for (const file of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    assert.match(read(`../android/app/src/main/res/mipmap-anydpi-v26/${file}`).toString(), /<monochrome android:drawable="@drawable\/ic_launcher_foreground"\/>/);
  }
});
