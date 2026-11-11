/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '\\.spec\\.ts$',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@sync/contracts$': '<rootDir>/../../../packages/contracts/src/index.ts',
  },
};
