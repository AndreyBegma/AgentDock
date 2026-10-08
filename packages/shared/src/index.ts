export * from './audit';
export * from './auth';
export * from './fleet';
export * from './live';
export * from './projects';
export * from './runners';
export * from './sessions';
export * from './usage';

export const formatDate = (date: Date): string =>
  date.toISOString().split('T')[0];
