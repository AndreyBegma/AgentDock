import { BadRequestException } from '@nestjs/common';
import { boardError } from '../board/board-error';
import { LocalError, toLocalError } from './local-error';

const of = (error: unknown) => {
  const local = toLocalError(error);
  return { code: local.code, message: local.message };
};

describe('toLocalError', () => {
  it("keeps the Board's own refusals by name (#845 D3)", () => {
    expect(
      of(boardError(409, 'dependency_open', 'C-1 waits for C-2', {})),
    ).toEqual({ code: 'dependency_open', message: 'C-1 waits for C-2' });
    expect(of(boardError(409, 'max_running', 'Three running'))).toEqual({
      code: 'max_running',
      message: 'Three running',
    });
    expect(
      of(boardError(503, 'command_unavailable', 'Update the runner')),
    ).toEqual({ code: 'command_unavailable', message: 'Update the runner' });
  });

  it('carries the BoardMoveRefusal of move_refused as its message', () => {
    expect(
      of(
        boardError(409, 'move_refused', 'This move is not allowed', {
          reason: 'fleet_slot',
        }),
      ),
    ).toEqual({ code: 'move_refused', message: 'fleet_slot' });
  });

  it('maps the rest by status, as before', () => {
    expect(of(boardError(404, 'not_found', 'Card not found')).code).toBe(
      'not_found',
    );
    expect(of(new BadRequestException('bad')).code).toBe('invalid_args');
    // A Board code no session tool passes through is no refusal of its own.
    expect(of(boardError(409, 'not_landed', 'Not on develop')).code).toBe(
      'internal',
    );
    expect(of(new Error('boom'))).toEqual({
      code: 'internal',
      message: 'internal error',
    });
    const typed = new LocalError('card_taken', 'held');
    expect(toLocalError(typed)).toBe(typed);
  });
});
