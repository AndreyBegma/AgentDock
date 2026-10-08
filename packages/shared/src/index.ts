export * from './audit';
export * from './auth';
export * from './control';
export * from './fleet';
export * from './live';
export * from './projects';
export * from './queue';
export * from './runners';
export * from './sessions';

export const formatDate = (date: Date): string =>
  date.toISOString().split('T')[0];
