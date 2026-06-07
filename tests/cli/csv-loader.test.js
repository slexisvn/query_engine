import { describe, it, expect } from 'vitest';
import path from 'path';
import { CSVLoader } from '../../src/cli/loaders/csv-loader.js';

describe('CSV loader path traversal protection', () => {
  it('rejects absolute path outside allowed directory', () => {
    const loader = new CSVLoader('/safe/dir');
    expect(() => loader.validatePath('/etc/passwd')).toThrow('Path traversal denied');
  });

  it('rejects relative path with .. going outside allowed dir', () => {
    const loader = new CSVLoader('/safe/dir');
    expect(() => loader.validatePath('/safe/dir/../../etc/passwd')).toThrow('Path traversal denied');
  });

  it('allows path within allowed directory', () => {
    const loader = new CSVLoader(process.cwd());
    const result = loader.validatePath(path.join(process.cwd(), 'data.csv'));
    expect(result).toBe(path.resolve(process.cwd(), 'data.csv'));
  });

  it('allows normal path when no allowedDir is set but path is in cwd', () => {
    const loader = new CSVLoader();
    const result = loader.validatePath('test.csv');
    expect(result).toBe(path.resolve('test.csv'));
  });

  it('rejects .. traversal outside cwd when no allowedDir set', () => {
    const loader = new CSVLoader();
    const outsidePath = path.join('..', '..', '..', '..', 'etc', 'passwd');
    const resolved = path.resolve(outsidePath);
    if (!resolved.startsWith(process.cwd())) {
      expect(() => loader.validatePath(outsidePath)).toThrow('Path traversal denied');
    }
  });
});
