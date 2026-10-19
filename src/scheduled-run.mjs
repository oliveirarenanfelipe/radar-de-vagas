import { open } from 'node:fs/promises';
import { fstatSync, ftruncateSync, readSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDataDir } from './data-dir.mjs';
import { COLLECT_LOCKED } from './collect.mjs';
import { acquireRunLock } from './run-lock.mjs';
import { main } from '../bin/radar.mjs';

function trimLog(fd) {
  const size = fstatSync(fd).size;
  if (size <= 1024 * 1024) return;
  const tail = Buffer.alloc(256 * 1024);
  const length = readSync(fd, tail, 0, tail.length, size - tail.length);
  // Evita iniciar no meio de um caractere UTF-8.
  let start = 0;
  while (start < length && (tail[start] & 0xc0) === 0x80) start++;
  ftruncateSync(fd, 0);
  writeSync(fd, tail.subarray(start, length));
}

export async function scheduledRun(dataDir, { run = main } = {}) {
  const directory = await ensureDataDir(dataDir);
  const release = acquireRunLock(directory);
  let log;
  try {
    log = await open(join(directory, 'agendamento.log'), 'a+', 0o600);
    const append = chunk => { writeSync(log.fd, chunk); if (release) trimLog(log.fd); };
    const output = message => append(`${new Date().toISOString()} ${message}\n`);
    if (!release) { output('Execução ignorada: a rodada anterior ainda está em andamento.'); return 0; }
    trimLog(log.fd);
    const options = { dataDir: directory, stdout: output, stderr: output,
      spawn: (command, args, config) => {
        const child = spawn(command, args, { ...config, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        return child;
      } };
    output('Início da execução agendada.');
    try {
      const collected = await run(['collect'], options);
      output(`Coleta encerrada com código ${collected}.`);
      // Coleta manual segurando coleta.lock: a agenda não coleta nem tria, e isso não é falha.
      if (collected === COLLECT_LOCKED) { output('Coleta manual em andamento; rodada agendada pulada.'); return 0; }
      if (collected === 130) return collected;
      const triaged = await run(['triage-run'], options);
      output(`Triagem encerrada com código ${triaged}.`);
      return collected || triaged;
    } catch (error) {
      output(`Falha na execução agendada: ${error.message}`);
      return 1;
    }
  } finally {
    try { await log?.close(); }
    finally { release?.(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (let i = 3; i < process.argv.length; i += 2) {
    if (process.argv[i] === '--path') process.env.PATH = process.argv[i + 1];
    if (process.argv[i] === '--data-env') process.env.RADAR_DATA_DIR = process.argv[i + 1];
  }
  process.exitCode = await scheduledRun(process.argv[2]);
}
