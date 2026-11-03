// Real subprocess fixture: pause at the filesystem boundary, without replacing its effects.
import { promises as fs } from 'node:fs';
const [directory, operation, id] = process.argv.slice(2);
const resume = () => new Promise(resolve => process.once('message', resolve));
const mkdir = fs.mkdir.bind(fs);
let reported = false;
fs.mkdir = async (...args) => {
  try { return await mkdir(...args); }
  catch (error) {
    if (String(args[0]).endsWith('tracker-association.lock') && error.code === 'EEXIST' && !reported) {
      reported = true;
      process.send('waiting');
    }
    throw error;
  }
};
const rename = fs.rename.bind(fs);
fs.rename = async (...args) => {
  if (String(args[1]).endsWith('tracker.json')) {
    process.send('rename');
    await resume();
  }
  return rename(...args);
};
const { writeTrackerAssociation, clearTrackerAssociation } = await import('../tracker-association.ts');
const result = operation === 'clear'
  ? await clearTrackerAssociation(directory)
  : await writeTrackerAssociation(directory, {
    kind: 'linear', source: { id: 'org', webUrl: 'https://linear.app' },
    externalId: id, externalName: id, [id]: true,
  });
process.send({ result });
process.disconnect();
