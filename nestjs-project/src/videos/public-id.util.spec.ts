import { QueryFailedError } from 'typeorm';
import {
  generatePublicId,
  isPublicIdConflict,
  persistWithUniquePublicId,
} from './public-id.util';

function makeUniqueViolation(column: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error()) as any;
  err.code = '23505';
  err.detail = `Key (${column})=(abc) already exists.`;
  return err as QueryFailedError;
}

describe('generatePublicId', () => {
  it('should produce 11 url-safe characters', () => {
    for (let i = 0; i < 100; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should not repeat within a large sample', () => {
    const ids = new Set(
      Array.from({ length: 10_000 }, () => generatePublicId()),
    );
    expect(ids.size).toBe(10_000);
  });
});

describe('isPublicIdConflict', () => {
  it('should recognise a unique violation on public_id', () => {
    expect(isPublicIdConflict(makeUniqueViolation('public_id'))).toBe(true);
  });

  it('should ignore a unique violation on another column', () => {
    expect(isPublicIdConflict(makeUniqueViolation('nickname'))).toBe(false);
  });

  it('should ignore errors that are not query failures', () => {
    expect(isPublicIdConflict(new Error('boom'))).toBe(false);
  });
});

describe('persistWithUniquePublicId', () => {
  it('should persist on the first attempt when there is no conflict', async () => {
    const persist = jest.fn().mockResolvedValue('saved');

    await expect(persistWithUniquePublicId(persist)).resolves.toBe('saved');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('should retry with a different id when public_id collides', async () => {
    const attempted: string[] = [];
    const persist = jest.fn((publicId: string) => {
      attempted.push(publicId);
      return attempted.length === 1
        ? Promise.reject(makeUniqueViolation('public_id'))
        : Promise.resolve('saved');
    });

    await expect(persistWithUniquePublicId(persist)).resolves.toBe('saved');
    expect(persist).toHaveBeenCalledTimes(2);
    expect(attempted[0]).not.toBe(attempted[1]);
  });

  it('should propagate errors that are not public_id conflicts', async () => {
    const persist = jest.fn().mockRejectedValue(new Error('connection lost'));

    await expect(persistWithUniquePublicId(persist)).rejects.toThrow(
      'connection lost',
    );
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('should give up after exhausting the retries', async () => {
    const persist = jest
      .fn()
      .mockRejectedValue(makeUniqueViolation('public_id'));

    await expect(persistWithUniquePublicId(persist)).rejects.toThrow(
      /could not be resolved/,
    );
    expect(persist).toHaveBeenCalledTimes(6);
  });
});
