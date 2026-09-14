// run-ticket.mjs - drive one ticket through the running app, exactly as the UI does.
//   node desktop/run-ticket.mjs <port> <title> <specFile> [cap]
const [, , port = '7390', title = 'test', specFile, cap = '1'] = process.argv;
const { readFileSync } = await import('node:fs');
const spec = readFileSync(specFile, 'utf8');
const base = `http://127.0.0.1:${port}`;
const say = (m) => process.stdout.write(m + '\n');
const t0 = Date.now();

const r = await fetch(`${base}/api/tasks`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ spec, title, cap: Number(cap) }),
});
const body = await r.json();
if (!body.id) { say(`CREATE FAILED ${r.status} ${JSON.stringify(body)}`); process.exit(1); }
say(`id ${body.id}`);

let last = '', stageAt = Date.now();
for (let i = 0; i < 900; i++) {
  await new Promise(res => setTimeout(res, 2000));
  const s = await (await fetch(`${base}/api/state`)).json();
  const t = s.tasks.find(x => x.id === body.id);
  const run = await (await fetch(`${base}/api/run?id=${body.id}`)).json();
  const key = `${t?.state}/${t?.attempt}/${Object.keys(t?.reviews || {}).length}/${run.status}`;
  if (key !== last) {
    say(`  ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${key}`);
    last = key; stageAt = Date.now();
  }
  if (run.status === 'error') {
    say(`\nERROR: ${run.error}`);
    say(`last events:\n` + (run.events || []).slice(-8).map(e => `  [${e.level}] ${e.stage}: ${String(e.text).replace(/\s+/g, ' ').slice(0, 160)}`).join('\n'));
    process.exit(2);
  }
  if (t?.state === 'delivered') {
    say(`\nDELIVERED in ${Math.round((Date.now() - t0) / 1000)}s  kind=${t.kind} mode=${t.output_mode} work=${t.model?.work} review=${t.model?.review} attempts=${t.attempt}/${t.cap}`);
    say(`reviews: ` + (t.review_slots || ['a','b']).map(k => `${k}=${t.reviews[k]?.result || '-'}`).join(' '));
    say(`\n--- payload (${(t.payload || '').length} chars) ---\n${(t.payload || '').slice(0, 2200)}`);
    const u = (await (await fetch(`${base}/api/usage`)).json());
    say(`\nusage so far: calls=${u.calls} in=${u.input} out=${u.output} cacheWrite=${u.cacheWrite} cost=$${u.costUsd.toFixed(2)}`);
    process.exit(0);
  }
  if (Date.now() - stageAt > 600000) { say('\nSTALLED: no state change in 10 minutes'); process.exit(3); }
}
say('TIMED OUT');
process.exit(4);
