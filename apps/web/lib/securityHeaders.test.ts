import { describe, expect, it } from 'vitest';
import { PERMISSIONS_POLICY } from './securityHeaders.mjs';

const directives = Object.fromEntries(PERMISSIONS_POLICY.split(',').map((d) => d.trim().split('=')));

describe('Permissions-Policy', () => {
  it('lets our own pages use the camera, for the packing video', () => {
    expect(directives.camera).toBe('(self)');
  });
  it('keeps the microphone for voice search, and location and topics off', () => {
    expect(directives).toEqual({ camera: '(self)', microphone: '(self)', geolocation: '()', 'browsing-topics': '()' });
  });
});
