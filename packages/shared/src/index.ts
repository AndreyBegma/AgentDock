export * from './audit';
export * from './auth';
export * from './runners';

export const formatDate = (date: Date): string =>
  date.toISOString().split('T')[0];
