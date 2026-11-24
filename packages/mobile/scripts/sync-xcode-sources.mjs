// Adds every Swift file under ios/App/App to the App target, one group per directory, with ids
// derived from the path so a rerun changes nothing. `--check` only reports what is missing: a file
// left out of project.pbxproj compiles in every check here and is simply absent from the Xcode build.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'ios/App/App');
const projectFile = join(root, 'ios/App/App.xcodeproj/project.pbxproj');
const APP_GROUP = '504EC3061FED79650016851F';
const SOURCES_PHASE = '504EC3001FED79650016851F';

// Old-style plist strings need quotes beyond this set: `ShellConnector+Push.swift` broke the parse.
const quoted = (name) => (/^[A-Za-z0-9_./-]+$/.test(name) ? name : `"${name}"`);
const id = (kind, path) => createHash('sha256').update(`${kind}:${path}`).digest('hex').slice(0, 24).toUpperCase();

function swiftFiles(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return swiftFiles(path);
    return name.endsWith('.swift') ? [relative(appDir, path)] : [];
  });
}

/** The group object for `dir` (relative to App), creating it and its parents. Returns its id. */
function groupFor(state, dir) {
  if (dir === '' || dir === '.') return APP_GROUP;
  const name = dir.split('/').pop();
  const parent = groupFor(state, dirname(dir) === '.' ? '' : dirname(dir));
  const existing = findChildGroup(state.text, parent, name);
  if (existing) return existing;
  const groupId = id('group', dir);
  state.text = state.text.replace('/* End PBXGroup section */',
    `\t\t${groupId} /* ${name} */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t);\n\t\t\tpath = ${name};\n\t\t\tsourceTree = "<group>";\n\t\t};\n/* End PBXGroup section */`);
  addChild(state, parent, groupId, name);
  return groupId;
}

function groupBody(text, groupId) {
  // The definition, not a child line naming it: that one is indented deeper and has no `= {`.
  const start = text.search(new RegExp(`\\n\\t\\t${groupId} /\\* [^*]+ \\*/ = \\{`));
  if (start < 0) throw new Error(`group ${groupId} not found`);
  const open = text.indexOf('children = (', start);
  const close = text.indexOf(');', open);
  return { open, close, body: text.slice(open, close) };
}

function findChildGroup(text, parent, name) {
  const { body } = groupBody(text, parent);
  for (const match of body.matchAll(/([0-9A-F]{24}) \/\* ([^*]+) \*\//g)) {
    if (match[2] !== name) continue;
    const def = new RegExp(`\\t\\t${match[1]} /\\* [^*]+ \\*/ = \\{\\n\\t\\t\\tisa = PBXGroup;`);
    if (def.test(text)) return match[1];
  }
  return null;
}

function addChild(state, groupId, childId, name) {
  const { close } = groupBody(state.text, groupId);
  state.text = `${state.text.slice(0, close)}\t${childId} /* ${name} */,\n\t\t\t${state.text.slice(close)}`;
}

const state = { text: readFileSync(projectFile, 'utf8') };
const referenced = new Set([...state.text.matchAll(/path = "?([^;"]+\.swift)"?;/g)].map((m) => m[1]));
// A name already in the project counts as present: the hand-made group layout predates this script.
const missing = swiftFiles(appDir).filter((path) => !referenced.has(path.split('/').pop()));

if (process.argv.includes('--check')) {
  if (missing.length) {
    console.error(`not in project.pbxproj (run npm run xcode:sync):\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log('every iOS Swift file is in the App target');
  process.exit(0);
}

for (const path of missing) {
  const name = path.split('/').pop();
  const fileId = id('file', path);
  const buildId = id('build', path);
  state.text = state.text.replace('/* End PBXFileReference section */',
    `\t\t${fileId} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${quoted(name)}; sourceTree = "<group>"; };\n/* End PBXFileReference section */`);
  state.text = state.text.replace('/* End PBXBuildFile section */',
    `\t\t${buildId} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileId} /* ${name} */; };\n/* End PBXBuildFile section */`);
  addChild(state, groupFor(state, dirname(path) === '.' ? '' : dirname(path)), fileId, name);
  const phase = state.text.search(new RegExp(`\\n\\t\\t${SOURCES_PHASE} /\\* Sources \\*/ = \\{`));
  const close = state.text.indexOf(');', state.text.indexOf('files = (', phase));
  state.text = `${state.text.slice(0, close)}\t${buildId} /* ${name} in Sources */,\n\t\t\t${state.text.slice(close)}`;
}
writeFileSync(projectFile, state.text);
console.log(missing.length ? `added ${missing.length} files` : 'nothing to add');
