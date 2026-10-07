export * from './audit';
export * from './auth';
export * from './live';
export * from './runners';

export const formatDate = (date: Date): string =>
  date.toISOString().split('T')[0];
