/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  setupFiles: ['<rootDir>/src/jest.setup.ts'],
  maxWorkers: 1,
  testTimeout: 60_000,
  moduleNameMapper: {
    '^@sync/contracts$': '<rootDir>/../packages/contracts/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        diagnostics: false,
      },
    ],
  },
};
