import { readFileSync } from 'node:fs';

import { declaredEnums, enumValues } from '../scripts/migrate.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

describe('migrate', () => {
  it('reads ENUM column definitions from the schema, so existing tables can gain new values', () => {
    const role = declaredEnums(schema).find((c) => c.table === 'users' && c.column === 'role');
    expect(role.values).toEqual(["'PASSENGER'", "'STAFF'", "'AUTHORITY'", "'ADMIN'"]);
    expect(role.definition).toBe("role ENUM('PASSENGER','STAFF','AUTHORITY','ADMIN') NOT NULL DEFAULT 'PASSENGER'");
    expect(declaredEnums(schema).find((c) => c.table === 'routes' && c.column === 'mode').definition).toBe("mode ENUM('BUS','TRAIN') NOT NULL");
  });

  it('reads the values of a MySQL column type', () => {
    expect(enumValues("enum('PASSENGER','STAFF','AUTHORITY')")).toEqual(["'PASSENGER'", "'STAFF'", "'AUTHORITY'"]);
  });
});
