import { describe, expect, it } from 'vitest';
import { parseCsv } from './codRemittance';

describe('parseCsv', () => {
  it('reads plain, quoted and escaped cells, over CRLF or LF', () => {
    const text = '﻿AWB,COD Amount,Note\r\n1490810000001,"1,234.50","said ""hi"""\n1490810000002,500,';
    expect(parseCsv(text)).toEqual([
      ['AWB', 'COD Amount', 'Note'],
      ['1490810000001', '1,234.50', 'said "hi"'],
      ['1490810000002', '500', ''],
    ]);
  });

  it('keeps a line break inside quotes in its cell, and ignores a final newline', () => {
    expect(parseCsv('a,"two\nlines"\n')).toEqual([['a', 'two\nlines']]);
  });
});
