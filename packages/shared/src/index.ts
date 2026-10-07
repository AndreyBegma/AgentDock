export * from './audit';
export * from './auth';
export * from './live';
export * from './projects';
export * from './runners';
export * from './sessions';

export const formatDate = (date: Date): string =>
  date.toISOString().split('T')[0];
