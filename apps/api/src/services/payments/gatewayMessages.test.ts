import { describe, expect, it } from 'vitest';
import { attemptFailedMessage } from './gatewaySync';

describe('attemptFailedMessage', () => {
  it("puts the gateway's reason in brackets inside our own sentence", () => {
    expect(attemptFailedMessage('Simulated response message')).toBe('The payment did not go through (Simulated response message).');
    expect(attemptFailedMessage('  Transaction declined by bank.  ')).toBe('The payment did not go through (Transaction declined by bank).');
    expect(`${attemptFailedMessage('Simulated response message')} Nothing was charged — you can try again.`).toBe(
      'The payment did not go through (Simulated response message). Nothing was charged — you can try again.',
    );
  });

  it('says it plainly when the gateway gave no reason', () => {
    expect(attemptFailedMessage(null)).toBe('The payment did not go through.');
    expect(attemptFailedMessage('   ')).toBe('The payment did not go through.');
  });
});
