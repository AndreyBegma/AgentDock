export * from './activity';
export * from './audit';
export * from './auth';
export * from './control';
export * from './fleet';
export * from './history';
export * from './live';
export * from './notifications';
export * from './projects';
export * from './queue';
export * from './runners';
export * from './sessions';
export * from './usage';

export const formatDate = (date: Date): string =>
  date.toISOString().split('T')[0];
