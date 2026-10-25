// Test helpers: the state `ror login` leaves on a machine, and a block put in a text the way the writer does.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import type { Enrolment } from '../session.js';
import { applyManaged } from '../managed.js';
import { defaultHome } from '../paths.js';
import { writeLogin } from '../state.js';

/** What a login writes: the server and organization, and the keys bundles are verified with. */
export function saveEnrolment(enrolment: Enrolment): void {
  writeLogin(
    defaultHome(),
    { server: enrolment.api, organization: enrolment.organization_id, device: 'dev_test' },
    { organization_id: enrolment.organization_id, keys: enrolment.keys },
  );
}

/** `text` with block `id` set by the managed writer; throws what the writer refuses. */
export function setBlock(
  text: string,
  style: 'html' | 'hash' | 'slash',
  id: string,
  content: string,
  path: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'ror-block-'));
  try {
    const name = `file${extname(path)}`;
    writeFileSync(join(dir, name), text);
    mkdirSync(join(dir, '.lock'));
    applyManaged(
      [
        {
          op: 'managed_block',
          path: `\${project}/${name}`,
          block_id: id,
          content,
          comment_style: style,
        },
      ],
      { roots: { project: dir }, lockPath: join(dir, '.lock', 'l.json') },
    );
    return readFileSync(join(dir, name), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
