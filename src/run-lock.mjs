import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Trava de rodada por PID (agenda e coleta). Devolve a função que libera, ou null se outra rodada a segura.
 * PID vivo nunca vence pelo tempo; PID morto é recuperado; trava sem PID válido só é recuperada após 30 s.
 */
export function acquireRunLock(directory, name = 'agendamento.lock') {
  const path = join(directory, name);
  while (true) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, String(process.pid)); }
      finally { closeSync(fd); }
      return () => unlinkSync(path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const before = statSync(path);
        const pid = Number(readFileSync(path, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); return null; }
          catch (error) { if (error.code !== 'ESRCH') return null; }
        } else if (Date.now() - before.mtimeMs < 30000) return null;
        const current = statSync(path);
        if (current.ino === before.ino && current.mtimeMs === before.mtimeMs) unlinkSync(path);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
