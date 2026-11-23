import { build } from 'esbuild';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
if (process.argv.includes('--test')) {
  const dir = await mkdtemp(join(tmpdir(), 'network-web-test-'));
  try {
    const outfile = join(dir, 'overview.cjs');
    await build({ entryPoints: ['test/overview.test.ts'], outfile, bundle: true, platform: 'node' });
    process.exitCode = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' }).status ?? 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else {
  const js = await build({ entryPoints: ['main.ts'], bundle: true, write: false, target: 'es2020', minify: true });
  let html = await readFile('home.html', 'utf8');
  const css = await readFile('home.css', 'utf8');
  html = html.replace('<link rel="stylesheet" href="/overview.css">', () => '<style>' + css + '</style>');
  html = html.replace('<script src="/overview.js"></script>', () => '<script>' + js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script') + '</script>');
  for (const file of ['rb5009.webp', 'rb5009upr.webp']) {
    const photo = await readFile(join('assets', file));
    html = html.replace('/overview/' + file, 'data:image/webp;base64,' + photo.toString('base64'));
  }
  await writeFile('../index.html', html);
}
